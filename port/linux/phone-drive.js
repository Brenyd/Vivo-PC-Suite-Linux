// Phone drive manager (Linux replacement for vivo's vdfs/Dokan "phone as a drive").
// Watches `adb devices`; every authorized phone gets mounted with vivo-phonefs.py at
//   ~/vivo Phone            (one phone)
//   ~/vivo Phone (<serial>) (more than one)
// and unmounted when it disconnects or the app quits. Disable with PCSUITE_NO_DRIVE=1.
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const ADB = () => process.env.PCSUITE_ADB || 'adb';
const PHONEFS = path.join(__dirname, 'vivo-phonefs.py');
const BASE = process.env.PCSUITE_MOUNT_DIR || path.join(os.homedir(), 'vivo Phone');
const PREFIXES = ['/storage/emulated/0', '/storage/self/primary', '/sdcard', '/mnt/sdcard'];
const mounts = new Map();   // serial -> mountpoint
let log = () => {};
let timer = null;

function mounted(dir) {
  try { return fs.readFileSync('/proc/self/mounts', 'utf8').split('\n').some(l => l.split(' ')[1] === dir.replace(/ /g, '\\040')); }
  catch (_) { return false; }
}
function unmount(dir) {
  for (const bin of ['fusermount3', 'fusermount']) {
    try { cp.execFileSync(bin, ['-u', '-z', dir], { stdio: 'ignore' }); break; } catch (_) {}
  }
  try { fs.rmdirSync(dir); } catch (_) {}
}
function mountPointFor(serial, count) { return count > 1 ? `${BASE} (${serial})` : BASE; }

function mount(serial, count) {
  const dir = mountPointFor(serial, count);
  if (mounted(dir)) unmount(dir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  try {
    if (fs.readdirSync(dir).length) { log(`phone drive: ${dir} is not empty, not mounting`); return; }
  } catch (_) {}
  const p = cp.spawn('python3', [PHONEFS, dir, '--serial', serial], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
  let err = '';
  p.stderr.on('data', d => { err += d; });
  p.on('error', e => log('phone drive: cannot start python3: ' + e.message));
  p.on('exit', code => {
    if (code === 0 && mounted(dir)) { mounts.set(serial, dir); log(`phone drive: ${serial} mounted at ${dir}`); }
    else log(`phone drive: mounting ${serial} failed (${code}) ${err.trim()}`);
  });
}

function poll() {
  cp.execFile(ADB(), ['devices'], { timeout: 8000 }, (e, out) => {
    if (e) return;
    const ready = out.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'device').map(p => p[0]);
    for (const [serial, dir] of mounts) if (!ready.includes(serial)) { unmount(dir); mounts.delete(serial); log(`phone drive: ${serial} removed`); }
    for (const s of ready) if (!mounts.has(s) && !pending.has(s)) {
      pending.add(s); mount(s, ready.length); setTimeout(() => pending.delete(s), 15000);
    }
  });
}
const pending = new Set();

module.exports = {
  start(logger) {
    if (process.env.PCSUITE_NO_DRIVE || timer) return;
    log = logger || log;
    poll(); timer = setInterval(poll, 3000);
    const stop = () => module.exports.stop();
    process.on('exit', stop);
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.once(sig, () => { stop(); process.exit(0); });
    try { require('electron').app.on('will-quit', stop); } catch (_) {}
  },
  stop() {
    if (timer) clearInterval(timer); timer = null;
    for (const dir of mounts.values()) unmount(dir);
    mounts.clear();
  },
  mounts() { return [...mounts.entries()]; },
  /** Map a phone path (/storage/emulated/0/...) to its path inside the mounted drive, or null. */
  localPath(phonePath, serial) {
    const dir = serial && mounts.get(serial) || [...mounts.values()][0];
    if (!dir || !phonePath) return null;
    const pre = PREFIXES.find(p => phonePath === p || phonePath.startsWith(p + '/'));
    if (!pre) return null;
    return path.join(dir, phonePath.slice(pre.length));
  },
  defaultMount() { return [...mounts.values()][0] || null; },
};
