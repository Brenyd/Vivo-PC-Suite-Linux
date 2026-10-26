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
  // screen mirroring (vivoScreen / PCMode)
  'pcmode.exe': () => scrcpy(['--window-title', 'vivo phone', '--stay-awake'], 'Screen mirroring'),
  'vivoscreen.exe': () => scrcpy(['--window-title', 'vivo phone', '--stay-awake'], 'Screen mirroring'),
  'vscreen.exe': () => scrcpy(['--window-title', 'vivo phone', '--stay-awake'], 'Screen mirroring'),
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
  // keyboard & mouse sharing: PC keyboard/mouse drive the phone as real (UHID) devices
  'vivorelay.exe': args => args.join(' ').includes('keyboardMouseCoordination')
    ? scrcpy(['--keyboard=uhid', '--mouse=uhid', '--max-size=1024', '--window-title', 'vivo keyboard & mouse'], 'Keyboard & mouse sharing') : null,
  'vrelay.exe': args => HANDLERS['vivorelay.exe'](args),
  'keymouse.exe': () => scrcpy(['--keyboard=uhid', '--mouse=uhid', '--max-size=1024', '--window-title', 'vivo keyboard & mouse'], 'Keyboard & mouse sharing'),
  // photo & video backup worker (SyncService/vivoBackup.exe) -> our Node worker (backup-worker.js)
  'vivobackup.exe': args => node('backup-worker.js', args),
  // call handoff window (phonecall/phoneCall.exe) -> in-app call card driven over adb (phone-call.js)
  'phonecall.exe': args => { const pc = require('./phone-call.js'); pc.setLogger(log); return { proc: pc.open(args) }; },
  // phone drive
  'vdfs.exe': () => {
    const dir = (require('./phone-drive.js').defaultMount()) || path.join(os.homedir(), 'vivo Phone');
    return fs.existsSync(dir) ? ['xdg-open', [dir]] : null;
  },
};

function resolveHandler(cmd, args) {
  cmd = cmd.replace(/^"|"$/g, '');
  const base = path.basename(cmd).toLowerCase();
  // our own executable scripts (pc_toast.exe, pcsuite_.exe, ...) keep working as-is
  try { const head = fs.readFileSync(cmd, { encoding: 'latin1' }).slice(0, 2); if (head === '#!') return null; } catch (_) {}
  if (HANDLERS[base]) return HANDLERS[base](args) || ['sh', ['-c', 'exit 0']];
  return ['sh', ['-c', 'exit 0']];          // Windows-only component with no Linux equivalent: exit quietly
}

module.exports = {
  install(logger) {
    log = logger || log;
    const origSpawn = cp.spawn;
    cp.spawn = function (cmd, args, opts) {
      if (typeof cmd === 'string' && /\.exe"?$/i.test(cmd)) {
        const a = Array.isArray(args) ? args : [];
        const o = Array.isArray(args) ? opts : args;
        log(`exe-dispatch: ${cmd} ${a.map(x => (/^--token=/.test(String(x)) ? '--token=***' : x)).join(' ')}`.slice(0, 1000));
        const h = resolveHandler(cmd, a);
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
