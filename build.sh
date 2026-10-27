#!/usr/bin/env bash
# Builds a native Linux version of vivo PC Suite / Office Kit from your Windows install.
#
#   ./build.sh <pcsuite folder | pcsuite .zip> [--prefix DIR] [--edition china|global] [--no-desktop]
#
# The Windows app is Electron (JavaScript). This script runs vivo's own code on the Linux build of
# the same Electron version, applies the Linux compatibility patches in ./port, adds the English
# completion pack, and installs a launcher + desktop entry. Nothing is downloaded from vivo.
set -euo pipefail

ELECTRON_VER=22.0.0
ELECTRON_SHA=ea0f4ad9a91bef4d5918d73c27b2731a5a93fe8917ad13d9eca83f39c5acbf05
SQLITE_VER=5.1.7
SQLITE_SHA=6d1f7a95e5aca90db1fd6a2839380a021d5ee23d46f2d7c520ded094da813fed

KIT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/vivo-pcsuite"
EDITION=china
DESKTOP=1
SRC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) PREFIX="$2"; shift ;;
    --edition) EDITION="$2"; shift ;;
    --no-desktop) DESKTOP=0 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) SRC="$1" ;;
  esac
  shift
done
[ -n "$SRC" ] || { sed -n '2,8p' "$0"; exit 1; }
case "$EDITION" in global|china) ;; *) echo "--edition must be global or china"; exit 1 ;; esac

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
for b in curl python3 sha256sum tar; do command -v "$b" >/dev/null || die "missing '$b'"; done
[ "$(uname -m)" = x86_64 ] || die "only x86_64 is supported"

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/vivo-pcsuite-linux"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$CACHE"

# ---------------------------------------------------------------- locate the Windows install
if [ -f "$SRC" ] && [[ "$SRC" == *.zip ]]; then
  say "Unpacking $(basename "$SRC")"
  python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$SRC" "$WORK/zip"
  SRC="$WORK/zip"
fi
ASAR="$(find "$SRC" -maxdepth 4 -path '*/resources/app.asar' -print -quit 2>/dev/null || true)"
[ -n "$ASAR" ] || die "couldn't find resources/app.asar under $SRC — point me at the pcsuite install folder"
WIN="$(dirname "$(dirname "$ASAR")")"
say "Windows install: $WIN"

# ---------------------------------------------------------------- downloads (pinned + verified)
fetch() { # url file sha
  if [ ! -f "$CACHE/$2" ] || ! echo "$3  $CACHE/$2" | sha256sum -c --status; then
    say "Downloading $2"
    curl -fL --retry 3 -o "$CACHE/$2.part" "$1"
    mv "$CACHE/$2.part" "$CACHE/$2"
  fi
  echo "$3  $CACHE/$2" | sha256sum -c --status || die "checksum mismatch for $2"
}
fetch "https://github.com/electron/electron/releases/download/v$ELECTRON_VER/electron-v$ELECTRON_VER-linux-x64.zip" \
      "electron-v$ELECTRON_VER-linux-x64.zip" "$ELECTRON_SHA"
fetch "https://github.com/TryGhost/node-sqlite3/releases/download/v$SQLITE_VER/sqlite3-v$SQLITE_VER-napi-v6-linux-x64.tar.gz" \
      "sqlite3-v$SQLITE_VER-napi-v6-linux-x64.tar.gz" "$SQLITE_SHA"

# ---------------------------------------------------------------- assemble
NEW="$PREFIX.new"; rm -rf "$NEW"; mkdir -p "$NEW"
say "Installing Electron $ELECTRON_VER (Linux)"
python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$CACHE/electron-v$ELECTRON_VER-linux-x64.zip" "$NEW"
chmod +x "$NEW/electron" "$NEW/chrome-sandbox" "$NEW/chrome_crashpad_handler" 2>/dev/null || true
rm -f "$NEW/resources/default_app.asar"
NODE() { ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS= "$NEW/electron" "$@"; }
NODE -e 'process.exit(0)' || die "the downloaded Electron doesn't run on this system"

say "Extracting vivo's app ($(du -h "$ASAR" | cut -f1))"
mkdir -p "$WORK/app"
python3 "$KIT/port/tools/asar.py" "$ASAR" "$WORK/app"
APP="$NEW/resources/app"
cp -a "$WORK/app" "$APP"
[ -d "$WIN/resources/app.asar.unpacked/node_modules" ] && cp -a "$WIN/resources/app.asar.unpacked/node_modules/." "$APP/node_modules/"

say "Applying Linux patches"
NODE "$KIT/port/apply.js" "$WORK/app" "$APP" || die "some patches failed — this PC Suite version may need an updated kit"
say "Applying English completion pack"
NODE "$KIT/port/i18n/apply-english.js" "$WORK/app" "$APP"

cp "$KIT/port/linux-boot.js" "$APP/"
mkdir -p "$APP/linux" && cp -a "$KIT/port/linux/." "$APP/linux/"
mkdir -p "$APP/itunes" && cp -a "$KIT/port/itunes/." "$APP/itunes/"
mkdir -p "$APP/i18n-data"
cp "$KIT/port/i18n/"{en-dict,dom-extra,dom-substrings,dom-rules}.json "$APP/i18n-data/"
NODE -e '
const f=process.argv[1], p=JSON.parse(require("fs").readFileSync(f,"utf8"));
p.main="./linux-boot.js"; p.productName="vivo Office Kit"; p.desktopName="vivo-pcsuite.desktop";
require("fs").writeFileSync(f, JSON.stringify(p,null,2));' "$APP/package.json"

# edition: china  = vivo's domestic build (China servers, all China-only features) - shown in English
#          global = vivo's international build (English, international servers)
cfg='{"IS_EXPORT": true, "CHANNEL_CODE": ""}'
[ "$EDITION" = china ] && cfg='{"IS_EXPORT": false, "CHANNEL_CODE": ""}'
echo "$cfg" > "$NEW/resources/build-config.json"

say "Adding Linux native pieces"
mkdir -p "$NEW/resources/sqlite3"
tar -xzf "$CACHE/sqlite3-v$SQLITE_VER-napi-v6-linux-x64.tar.gz" -C "$WORK"
cp "$WORK/build/Release/node_sqlite3.node" "$NEW/resources/sqlite3/"
cp -a "$KIT/port/bin/." "$NEW/"
python3 "$KIT/port/tools/ico2png.py" "$WIN/logo.ico" "$NEW/logo.png" 2>/dev/null || warn "no app icon found (logo.ico)"
chmod +x "$NEW/vivo-pcsuite" "$NEW/pcsuite_.exe" "$NEW/pc_toast.exe" "$NEW"/vivoScreen/*.exe "$NEW"/vdfs/*.exe

NODE -e 'require(process.argv[1])' "$NEW/resources/sqlite3/node_sqlite3.node" || die "sqlite3 module failed to load"
NODE -e '
const fs=require("fs"),vm=require("vm"),d=process.argv[1];let bad=0;
for(const f of fs.readdirSync(d).filter(f=>f.endsWith(".js"))){try{new vm.Script(fs.readFileSync(d+"/"+f,"utf8"),{filename:f})}catch(e){console.error(f+": "+e.message);bad++}}
process.exit(bad?1:0)' "$APP/dist/electron" || die "a patched file has a syntax error"

# ---------------------------------------------------------------- swap into place
if [ -d "$PREFIX" ]; then rm -rf "$PREFIX.old"; mv "$PREFIX" "$PREFIX.old"; fi
mv "$NEW" "$PREFIX"; rm -rf "$PREFIX.old"
say "Installed to $PREFIX"

if [ "$DESKTOP" = 1 ]; then
  BIN="$HOME/.local/bin"; APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps"
  mkdir -p "$BIN" "$APPS" "$ICONS"
  ln -sf "$PREFIX/vivo-pcsuite" "$BIN/vivo-pcsuite"
  [ -f "$PREFIX/logo.png" ] && cp "$PREFIX/logo.png" "$ICONS/vivo-pcsuite.png"
  cat > "$APPS/vivo-pcsuite.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=vivo Office Kit
GenericName=Phone Manager
Comment=vivo PC Suite – connect your vivo phone, transfer files, sync notes
Exec="$PREFIX/vivo-pcsuite" %U
Icon=vivo-pcsuite
Terminal=false
Categories=Utility;
Keywords=vivo;phone;android;pcsuite;transfer;
MimeType=x-scheme-handler/vivo-pcsuite;
StartupWMClass=pcsuite
EOF
  command -v update-desktop-database >/dev/null && update-desktop-database -q "$APPS" || true
  command -v xdg-mime >/dev/null && xdg-mime default vivo-pcsuite.desktop x-scheme-handler/vivo-pcsuite || true
  say "Added 'vivo Office Kit' to your app menu and 'vivo-pcsuite' to ~/.local/bin"
fi

# ---------------------------------------------------------------- dependency check
echo
command -v adb >/dev/null || warn "adb not found — needed to talk to the phone: sudo pacman -S android-tools android-udev"
command -v scrcpy >/dev/null || warn "scrcpy not found — needed for screen mirroring: sudo pacman -S scrcpy"
command -v fusermount3 >/dev/null || command -v fusermount >/dev/null || warn "FUSE not found — needed for the phone drive (~/vivo Phone): sudo pacman -S fuse3"
command -v ffmpeg >/dev/null || warn "ffmpeg not found — needed to edit song tags, read some formats and convert songs for the phone: sudo pacman -S ffmpeg"
command -v notify-send >/dev/null || warn "notify-send not found — optional, for desktop notifications: sudo pacman -S libnotify"
[ -e /sys/module/v4l2loopback ] || echo "   (optional) phone camera as webcam: sudo pacman -S v4l2loopback-dkms && sudo modprobe v4l2loopback card_label=\"vivo Phone Camera\" exclusive_caps=1"
say "Done. Start it from the app menu, or run: vivo-pcsuite"
