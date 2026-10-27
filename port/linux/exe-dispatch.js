// Routes vivo's Windows helper programs (*.exe) to Linux equivalents.
// vivo's code spawns e.g. "<install>/vivoCamera/vCamera.exe --ip .. --port ..". We intercept every spawn of
// an .exe, log it (~/.config/pcsuite/log/linux.log), and start the Linux replacement instead.
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

let log = () => {};
const ADB = () => process.env.PCSUITE_ADB || 'adb';
const has = bin => { try { cp.execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const notify = (title, body) => { log('notify: ' + title + ' - ' + body); try { const p = cp.spawn('notify-send', ['-a', 'vivo Office Kit', '-i', 'smartphone', title, body], { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); } catch (_) {} };

function adbSerial() {
  try {
    const out = cp.execFileSync(ADB(), ['devices'], { encoding: 'utf8', timeout: 5000 });
    const ready = out.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'device').map(p => p[0]);
    return ready.find(s => !s.includes(':')) || ready[0] || null;   // prefer USB
  } catch (_) { return null; }
}

/** First v4l2loopback device, if the module is loaded. */
function loopbackDevice() {
  try {
    for (const d of fs.readdirSync('/sys/class/video4linux')) {
      const name = fs.readFileSync(`/sys/class/video4linux/${d}/name`, 'utf8').trim();
      if (/loopback|vivo|dummy/i.test(name)) return `/dev/${d}`;
    }
  } catch (_) {}
  return null;
}

function scrcpy(extra, what) {
  if (!has('scrcpy')) { notify(`${what} needs scrcpy`, 'Install it with: sudo pacman -S scrcpy'); return null; }
  const serial = adbSerial();
  if (!serial) { notify(what, 'Connect the phone with USB (USB debugging on) first.'); return null; }
  const args = ['-s', serial, ...extra, ...(process.env.PCSUITE_SCRCPY_ARGS ? process.env.PCSUITE_SCRCPY_ARGS.split(' ') : [])];
  log(`exe-dispatch: scrcpy ${args.join(' ')}`);
  return ['scrcpy', args];
}

/** Run one of our Node workers with Electron's built-in Node. */
function node(script, args) {
  return [process.execPath, [path.join(__dirname, script), ...args], { ELECTRON_RUN_AS_NODE: '1' }];
}

// basename (lowercase) -> function(args) => [command, args] | null (= harmless placeholder process)
const HANDLERS = {
  // screen mirroring (vivoScreen / PCMode): only when the user asked for it (see guarded() below)
  'pcmode.exe': () => ({ kind: 'mirror' }),
  'vivoscreen.exe': () => ({ kind: 'mirror' }),
  'vscreen.exe': () => ({ kind: 'mirror' }),
  // phone camera as a PC webcam (vivoCamera / vCamera) -> scrcpy camera source into v4l2loopback
  'vcamera.exe': () => {
    const dev = loopbackDevice();
    if (!dev) {
      notify('Phone camera as webcam', 'Load the virtual camera first: sudo modprobe v4l2loopback card_label="vivo Phone Camera" exclusive_caps=1');
      return null;
    }
    return scrcpy(['--video-source=camera', '--camera-facing=back', '--camera-size=1920x1080', `--v4l2-sink=${dev}`,
      '--no-audio', '--no-playback', '--no-control'], 'Phone camera as webcam');
  },
  // keyboard & mouse sharing (vivoRelay). vivo starts the relay by itself at launch as a background service and
  // restarts it whenever it exits, so it must never open a window on its own: it opens only when the user asked.
  'vivorelay.exe': () => ({ kind: 'keymouse' }),
  'vrelay.exe': () => ({ kind: 'keymouse' }),
  'keymouse.exe': () => ({ kind: 'keymouse' }),
  // photo & video backup worker (SyncService/vivoBackup.exe) -> our Node worker (backup-worker.js)
  'vivobackup.exe': args => node('backup-worker.js', args),
  // call handoff window (phonecall/phoneCall.exe) -> in-app call card driven over adb (phone-call.js)
  'phonecall.exe': args => { const pc = require('./phone-call.js'); pc.setLogger(log); return { proc: pc.open(args) }; },
  // phone drive
  // phone drive. vivo starts vdfs (its Dokan drive service) by itself at launch and restarts it when it exits;
  // the drive is mounted automatically here, so a folder window only opens when the user asked for one.
  'vdfs.exe': () => ({ kind: 'drive' }),
};

// ---- windows that need a user request (screen mirroring, keyboard & mouse, the phone drive folder)
const SCRCPY = {
  mirror: { args: ['--window-title', 'vivo phone', '--stay-awake'], what: 'Screen mirroring' },
  keymouse: { args: ['--keyboard=uhid', '--mouse=uhid', '--max-size=1024', '--window-title', 'vivo keyboard & mouse'], what: 'Keyboard & mouse' },
};
const running = { mirror: null, keymouse: null, drive: null };     // the real scrcpy window per kind
const held = { mirror: new Set(), keymouse: new Set(), drive: new Set() }; // stand-ins given to vivo for launches nobody asked for
function driveDir() { try { return require('./phone-drive.js').defaultMount(); } catch (_) { return null; } }
let intent = null;

/** A do-nothing process that lives as long as the app (or until killed), so vivo sees its helper "running"
 *  and stops restarting it. */
function placeholder(kind) {
  const p = cp.spawn('sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 5; done`], { stdio: ['ignore', 'pipe', 'pipe'] });
  p.on('error', () => {});
  if (kind) { held[kind].add(p); p.on('exit', () => held[kind].delete(p)); }
  return p;
}
function releaseHeld(kind) { for (const p of held[kind]) { try { p.kill(); } catch (_) {} } held[kind].clear(); }

/** Open (or focus) the real window for `kind`. Returns the process, or null. */
function open(kind, opts) {
  if (kind === 'drive') {
    const dir = driveDir() || process.env.PCSUITE_MOUNT_DIR || path.join(os.homedir(), 'vivo Phone');
    if (!fs.existsSync(dir)) { notify('Phone drive', 'The phone isn\'t mounted yet. Connect it with USB (USB debugging on).'); return null; }
    require('./open-folder.js').openFolder(dir, log);
    return placeholder(null);
  }
  if (running[kind]) return running[kind];
  const s = scrcpy(SCRCPY[kind].args, SCRCPY[kind].what);
  if (!s) return null;
  const o = Object.assign({}, opts || {}, { shell: false });
  if (o.cwd && !fs.existsSync(o.cwd)) delete o.cwd;
  const p = cp.spawn(s[0], s[1], o);
  p.on('error', e => log(`exe-dispatch: ${kind}: ${e.message}`));
  for (const st of [p.stdout, p.stderr]) if (st) st.on('data', () => {});   // keep scrcpy from blocking on a full pipe
  running[kind] = p;
  p.on('exit', () => { if (running[kind] === p) running[kind] = null; log(`exe-dispatch: ${kind} window closed`); });
  return p;
}

function guarded(kind, opts) {
  if (running[kind]) { log(`exe-dispatch: ${kind} already open`); return placeholder(null); }
  if (intent && intent.consume(kind)) { log(`exe-dispatch: ${kind} requested by the user, opening`); return open(kind, opts) || placeholder(null); }
  log(`exe-dispatch: ${kind} not requested by the user (vivo background start), not opening a window`);
  return placeholder(kind);
}

function resolveHandler(cmd, args) {
  cmd = cmd.replace(/^"|"$/g, '');
  const base = path.basename(cmd).toLowerCase();
  // phone windows go through the user-request guard first, even though PCMode.exe is also a script here
  const GUARDED = ['pcmode.exe', 'vivoscreen.exe', 'vscreen.exe', 'vivorelay.exe', 'vrelay.exe', 'keymouse.exe', 'vdfs.exe'];
  if (GUARDED.includes(base)) return HANDLERS[base](args);
  // our own executable scripts (pc_toast.exe, pcsuite_.exe, ...) keep working as-is
  try { const head = fs.readFileSync(cmd, { encoding: 'latin1' }).slice(0, 2); if (head === '#!') return null; } catch (_) {}
  if (HANDLERS[base]) return HANDLERS[base](args) || ['sh', ['-c', 'exit 0']];
  return ['sh', ['-c', 'exit 0']];          // Windows-only component with no Linux equivalent: exit quietly
}

module.exports = {
  /** Used by the music/iTunes window: open mirroring or keyboard & mouse directly. */
  launch(kind) { if (intent) intent.consume(kind); return !!open(kind); },
  isOpen(kind) { return !!running[kind]; },
  install(logger, userIntent) {
    log = logger || log;
    intent = userIntent || null;
    // a click on a mirroring / keyboard & mouse control releases vivo's stand-in, so vivo's own restart opens it
    if (intent) intent.onClick(t => { const k = intent.classify(t); if (k && held[k].size) { log(`exe-dispatch: ${k} requested, releasing vivo's stand-in`); releaseHeld(k); } });
    const origSpawn = cp.spawn;
    cp.spawn = function (cmd, args, opts) {
      if (typeof cmd === 'string' && /\.exe"?$/i.test(cmd)) {
        const a = Array.isArray(args) ? args : [];
        const o = Array.isArray(args) ? opts : args;
        log(`exe-dispatch: ${cmd} ${a.map(x => (/^--token=/.test(String(x)) ? '--token=***' : x)).join(' ')}`.slice(0, 1000));
        const h = resolveHandler(cmd, a);
        if (h && h.kind) return guarded(h.kind, o);
        if (h && h.proc) return h.proc;
        if (h) {
          const clean = Object.assign({}, o || {});
          if (clean.cwd && !fs.existsSync(clean.cwd)) delete clean.cwd;
          if (h[2]) clean.env = Object.assign({}, clean.env || process.env, h[2]);
          if (h[2] || h[0] === process.execPath) clean.shell = false;
          return origSpawn.call(this, h[0], h[1], clean);
        }
      }
      return origSpawn.apply(this, arguments);
    };
  },
};
