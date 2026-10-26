# vivo PC Suite (Office Kit) for Linux

Run **vivo PC Suite / vivo Office Kit** natively on Linux, with an English UI and no Wine.

The kit takes **your own Windows install** of vivo PC Suite and rebuilds it into a native Linux app. vivo's
Windows-only helper programs are replaced with Linux implementations: a FUSE phone drive, photo backup over
adb, a call-handoff window, scrcpy mirroring and more. It's aimed at vivo phones (including China models)
that don't do normal USB/MTP file transfer.

<p align="center"><img src="docs/screenshots/home.png" width="860" alt="Home screen on Linux"></p>

| | |
|---|---|
| <img src="docs/screenshots/notes.png" alt="Notes"> | <img src="docs/screenshots/calendar.png" alt="Calendar"> |
| **Notes** | **Calendar** |
| <img src="docs/screenshots/albums.png" alt="Albums"> | <img src="docs/screenshots/recorder.png" alt="Recorder"> |
| **Albums** | **Recorder** |
| <img src="docs/screenshots/connect.png" alt="Connect a device"> | <img src="docs/screenshots/settings.png" alt="Settings"> |
| **Connect a phone** | **Settings** |

<p align="center">
<img src="docs/screenshots/usb-connect.png" width="240" alt="USB connect prompt">&nbsp;&nbsp;
<img src="docs/screenshots/call-incoming.png" width="300" alt="Incoming call card">&nbsp;&nbsp;
<img src="docs/screenshots/call-active.png" width="300" alt="Active call card">
</p>
<p align="center"><sub>USB connection prompt · incoming call on the PC · call in progress</sub></p>

> The screenshots show the **China edition** (the default) running on Linux in English, taken without a
> phone signed in. Not affiliated with or endorsed by vivo. You need your own copy of vivo PC Suite; this
> repo doesn't distribute any vivo software.

## How it works

The Windows app is an Electron program, so its interface and logic are JavaScript. `build.sh` runs vivo's own
code on the **Linux build of the same Electron version (22.0.0)** and patches out the Windows-only parts. Each
native Windows helper (`.exe`/`.dll`) was reverse-engineered and replaced with a Linux implementation (see
the table below). Phone communication goes through `adb`, the same tool PC Suite bundles as `adb.exe`.

Tested with vivo PC Suite **7.0.6**.

## Install (CachyOS / Arch)

```bash
sudo pacman -S --needed android-tools android-udev scrcpy fuse3 libnotify python git
git clone https://github.com/Brenyd/Vivo-PC-Suite-Linux.git
cd Vivo-PC-Suite-Linux
./build.sh "/path/to/your/pcsuite"   # the installed Windows folder, or a .zip of it
```

Where to get the Windows folder: install vivo PC Suite with Proton or Wine once, just to unpack it, then point
`build.sh` at the `pcsuite` folder. With Steam/Proton, for example:

```bash
./build.sh "$HOME/.steam/steam/steamapps/compatdata/<appid>/pfx/drive_c/Program Files (x86)/pcsuite"
```

The build downloads exactly two files, each pinned by SHA-256: Electron 22.0.0 for Linux and the sqlite3
native module (both from GitHub). It installs to `~/.local/share/vivo-pcsuite` and adds **vivo Office Kit** to
your app menu and `vivo-pcsuite` to `~/.local/bin`. Re-run it any time: it replaces the previous build atomically.

Options:

- `--edition china|global`. The default is `china`: vivo's domestic build, for China-model phones and China vivo
  accounts, with the UI in English. `global` is the international build.
- `--prefix DIR`
- `--no-desktop`

## Phone setup (one time)

1. **Settings → About phone → Software version**: tap it 7 times to unlock Developer options.
2. **Developer options → USB debugging**: on.
3. Plug in the phone, unlock it, and accept **Allow USB debugging** (tick *Always allow*).
4. In the app, click **No network. Use USB connection** (or **Connect**), then tap **Agree** if the phone asks.

## Features and what replaces the Windows parts

| Feature | Windows | Linux |
|---|---|---|
| UI language | Chinese in the China edition | English. vivo's locale keys are merged, about 4,500 hard-coded strings are translated at build time, and a live translation layer handles the rest. Set `PCSUITE_LANG=zh_CN` for Chinese |
| Phone connection | `adb.exe` | your system `adb` (`PCSUITE_ADB=/path` to override) |
| **Phone as a drive** | Dokan driver (`vdfs.exe`) | FUSE file system over adb. Mounts automatically at `~/vivo Phone` while the phone is connected (read, write, rename, delete) |
| Drag phone files to the desktop | Windows virtual-file drag | drags straight from the mounted phone drive |
| **Photo & video backup** | `vivoBackup.exe` | `backup-worker.js`: copies new photos/videos from DCIM, Pictures and Movies into `<backup folder>/<phone>/<album>/`. Incremental, keeps file dates, drives the app's progress card, auto-backup and pause |
| **Answer calls on the PC** | `phoneCall.exe` | call card with Answer, Decline, Hang up and Mute, driven over adb. Closes when the call ends. **Listen on PC** plays the call audio through scrcpy (Android 11+) |
| Screen mirroring / PC mode | `PCMode.exe`, `vivoScreen.exe` | **scrcpy** |
| Keyboard & mouse sharing | `vivoRelay.exe` | scrcpy with UHID keyboard/mouse, so the PC's keyboard and mouse control the phone |
| Phone camera as webcam | `vCamera.exe` | scrcpy camera → v4l2loopback virtual webcam (setup below) |
| Local databases (notes, calendar, albums, recorder, settings) | created by `vivoSyncService.exe` | `db-init.js` creates the same SQLite schemas and migrations (recovered from the service binary) |
| Notifications | `pc_toast.exe` | `notify-send` |
| Open / reveal files, disk space, OS info | `dragfile.node` | `xdg-open`, `gio`, FileManager1 D-Bus (Dolphin highlights the file), `df` |
| PC file search | Everything SDK | `plocate`/`locate` when installed, otherwise `find` in your home folder |
| Registry reads (region, user) | `regedit` + `cscript` | answered from the Linux environment |
| Tray icon / window | `.ico`, Windows title bar | PNG icon, vivo's own title bar |
| Auto-update / hot patches | downloads Windows files | turned off. Update by installing the new Windows version and re-running `build.sh` |

### Phone camera as a webcam (optional)

```bash
sudo pacman -S v4l2loopback-dkms
sudo modprobe v4l2loopback card_label="vivo Phone Camera" exclusive_caps=1
# make it permanent:
echo v4l2loopback | sudo tee /etc/modules-load.d/v4l2loopback.conf
echo 'options v4l2loopback card_label="vivo Phone Camera" exclusive_caps=1' | sudo tee /etc/modprobe.d/v4l2loopback.conf
```

### Not available on Linux

- **vivo-account cloud sync** of Notes, Calendar, Albums and Recorder (`vivoSyncService.exe`). This is vivo's
  proprietary, request-signed sync engine. Re-implementing it without vivo's server specification could corrupt or
  delete cloud data, so it is left out. Everything on the phone over USB still works, and the cloud data stays
  available on the phone and at vivo's web cloud.
- Call audio **from the PC microphone** to the phone. Audio plays on the PC (Listen on PC), but you talk through
  the phone.
- Extended screen (phone as a second monitor) and Remote PC. Both need vivo's Windows display/remote drivers.
- The voice-recorder audio engine (`vaudio_kernel.dll`). vivo already ships no-op stubs for this on macOS.

## Settings (environment variables)

| Variable | Effect |
|---|---|
| `PCSUITE_LANG` | UI language (default `en_US`) |
| `PCSUITE_COUNTRY` | region code (China edition default: `CN`) |
| `PCSUITE_ADB` | adb binary |
| `PCSUITE_NO_DRIVE=1` | don't mount the phone drive |
| `PCSUITE_MOUNT_DIR` | where to mount it (default `~/vivo Phone`) |
| `PCSUITE_BACKUP_DIRS` | phone folders to back up (default `/sdcard/DCIM:/sdcard/Pictures:/sdcard/Movies`) |
| `PCSUITE_SCRCPY_ARGS` | extra scrcpy options for mirroring |
| `PCSUITE_NO_SANDBOX=1` | run without the Chromium sandbox |
| `PCSUITE_REQUIRE_PHONE_UPDATE=1` | enforce vivo's minimum phone-app version (off by default, see Troubleshooting) |
| `PCSUITE_DEBUG=1` | verbose log |

## Troubleshooting

- **Phone shows as "unauthorized"**: unlock it and accept the USB-debugging prompt. Run `adb devices` to check.
- **"This device model cannot connect"**: the phone's system has no `com.vivo.pcsuite` service. Check with
  `adb shell pm path com.vivo.pcsuite`.
- **"Update vivo Office Kit on the phone"**: the phone half of Office Kit is a vivo system app that only updates
  through the phone's system updates, and many China phones never get the version Windows PC Suite 7.0.6 requires.
  The Linux build skips that version check, so older phone versions connect anyway. If one feature misbehaves
  with an old phone version, `PCSUITE_REQUIRE_PHONE_UPDATE=1` turns the check back on.
- **Phone drive doesn't appear**: install `fuse3`, and make sure `~/vivo Phone` is empty.
- **Blank window or sandbox error**: run `PCSUITE_NO_SANDBOX=1 vivo-pcsuite`.
- Logs are in `~/.config/pcsuite/log/`:
  - `linux.log`: this port, including every Windows program the app tried to start and what replaced it.
  - `backup_log/backup-linux.log`: photo backup.
  - vivo's own logs.

## Project layout

- `port/patches.js`: 22 small, documented patches to vivo's bundles. `apply.js` fails loudly if a future
  PC Suite version no longer matches one.
- `port/linux-boot.js`: entry point. It fills in Windows-only Electron APIs, maps native modules to
  `port/linux/*.js`, creates the databases, and starts the phone drive and the translation layer. Then it loads
  vivo's `main.js`.
- `port/linux/exe-dispatch.js`: intercepts every launch of a vivo `.exe` and starts the Linux replacement.
- `port/linux/`: the replacements (`backup-worker.js`, `phone-call.js`, `phone-drive.js` + `vivo-phonefs.py`,
  `dragfile-linux.js`, `filesearch-linux.js`, `regedit-linux.js`, `db-init.js`, `dom-i18n.js`).
- `port/i18n/`: the English pack and its patcher. It only touches display text, and skips any string the code
  also compares against.

This repo contains no vivo program code. vivo's app is taken from your own installed copy at build time. The
repo only includes translation tables for the app's interface text and the database schema needed to
recreate its local databases.
