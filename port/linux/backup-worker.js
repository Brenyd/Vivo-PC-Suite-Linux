#!/usr/bin/env node
// Linux replacement for vivo's SyncService/vivoBackup.exe ("Back up photos & videos").
//
// vivo starts it as:  vivoBackup.exe --port=9199 --uri="/backup?hashId=backup" --logPath="..."
// It connects back to the app's local WebSocket server and speaks the app-process protocol:
//   app -> worker   msg:{"name":"AlbumBackupConfigure","msgId":..,"payload":"<json>"}
//   worker -> app   msg:{"name":"AlbumBackupInfo","msgId":..,"payload":"<json>"}
// Photos/videos are copied from the phone over adb (USB) into <backup folder>/<device name>/<album>/,
// incrementally (already backed-up files are skipped), keeping the phone's modification times.
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');

// ---------- args / logging ----------
const arg = k => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`) || x === `--${k}`);
  if (!a) return null;
  const v = a.includes('=') ? a.slice(a.indexOf('=') + 1) : process.argv[process.argv.indexOf(a) + 1];
  return v && v.replace(/^"|"$/g, '');
};
const PORT = Number(arg('port')) || 9199;
const URI = arg('uri') || arg('url') || '/backup?hashId=backup';
const LOGDIR = arg('logPath') || arg('log') || path.join(os.homedir(), '.config/pcsuite/log/backup_log');
try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (_) {}
const LOGFILE = path.join(LOGDIR, 'backup-linux.log');
function log(...a) {
  const line = `[${new Date().toISOString()}] ${a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
  try { fs.appendFileSync(LOGFILE, line); } catch (_) {}
  if (process.env.PCSUITE_DEBUG) process.stderr.write(line);
}

const ADB = process.env.PCSUITE_ADB || 'adb';
const MEDIA_ROOTS = (process.env.PCSUITE_BACKUP_DIRS || '/sdcard/DCIM:/sdcard/Pictures:/sdcard/Movies').split(':');
const PHOTO = /\.(jpe?g|png|heic|heif|webp|gif|bmp|dng|raw)$/i;
const VIDEO = /\.(mp4|3gp|mov|mkv|webm|m4v|avi)$/i;

// Same values the UI uses (BACKUP_STATUS / BACKUP_ERROR)
const STATUS = { NEVER_STARTED: 0, NOT_STARTED: 1, DOING: 2, START: 3, SUCCESS: 4, RECOGNIZING: 5, FAILED: 10, PAUSED: 11 };
const ERR = { NONE: 0, PHONE_INFO_FAILED: 1001, GET_IMG_INFO_FAILED: 1003, IMG_DOWNLOAD_FAILED: 1010, COMPUTER_STORAGE_UNENOUGH: 1020, CONNECT_ALBUM_FAILED: 9999 };

// ---------- WebSocket to the app ----------
let WS;
try { WS = require(path.join(__dirname, '..', 'node_modules', 'ws')); } catch (_) { WS = require('ws'); }
let sock = null;
const guid = () => crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
function send(name, payload) {
  if (!sock || sock.readyState !== 1) return;
  sock.send('msg:' + JSON.stringify({ name, msgId: guid(), payload: typeof payload === 'string' ? payload : JSON.stringify(payload) }));
}
function connect() {
  const url = `ws://127.0.0.1:${PORT}${URI}`;
  log('connecting', url);
  sock = new WS(url);
  sock.on('open', () => log('connected'));
  sock.on('message', d => onMessage(d.toString()));
  sock.on('error', e => log('ws error', e.message));
  sock.on('close', () => { log('ws closed, exiting'); stopAll(); setTimeout(() => process.exit(0), 200); });
}
setInterval(() => { if (sock && sock.readyState === 1) sock.send('heartbeat:' + JSON.stringify({ msgId: guid() })); }, 15000);

// ---------- per-device state ----------
const devices = new Map();   // deviceName -> {cfg, info, job}
function dev(name) {
  if (!devices.has(name)) devices.set(name, {
    cfg: { deviceName: name, savePath: '', isAutoBackup: false },
    info: { deviceName: name, backupIndex: 0, unBackupCount: -1, hasBackupCount: -1, totalFileCount: -1, status: STATUS.NEVER_STARTED,
      lastBackupTime: -1, errorCode: ERR.NONE, errorMsg: '', isDownloadThumb: false, isAutoBackup: false },
    job: null,
  });
  return devices.get(name);
}
function report(d, patch) {
  Object.assign(d.info, patch, { isAutoBackup: !!d.cfg.isAutoBackup });
  send('AlbumBackupInfo', d.info);
}

function onMessage(raw) {
  if (raw.startsWith('receipt:') || raw.startsWith('heartbeat:')) return;
  if (raw.startsWith('close:')) { stopAll(); process.exit(0); }
  if (!raw.startsWith('msg:') && !raw.startsWith('command:')) return log('unknown message', raw.slice(0, 200));
  let m; try { m = JSON.parse(raw.slice(raw.indexOf(':') + 1)); } catch (e) { return log('bad json', raw.slice(0, 200)); }
  let p = m.payload;
  try { if (typeof p === 'string' && /^[{[]/.test(p)) p = JSON.parse(p); } catch (_) {}
  if (typeof p === 'string') p = p.replace(/^"|"$/g, '');
  log('<-', m.name, typeof p === 'object' ? Object.assign({}, p, { token: p && p.token ? '***' : undefined }) : p);
  const name = typeof p === 'string' ? p : p && p.deviceName;
  switch (m.name) {
    case 'AlbumBackupConfigure': {
      const d = dev(name); Object.assign(d.cfg, p); loadIndexMeta(d);
      break;
    }
    case 'AlbumBackupChangeConfigure': {
      const d = dev(name); const wasAuto = d.cfg.isAutoBackup;
      Object.assign(d.cfg, p); loadIndexMeta(d);
      if (wasAuto && !p.isAutoBackup) stop(d, 'switch');
      else report(d, {});
      break;
    }
    case 'AlbumBackupStartJob': start(dev(name)); break;
    case 'AlbumBackupStopJob': stop(dev(name), p && p.reason); break;
    case 'AlbumBackupGetBackupProcess': report(dev(name), {}); break;
    default: log('ignored', m.name);
  }
}

// ---------- adb helpers ----------
function adb(args, opts = {}) {
  return new Promise((res, rej) => {
    const p = cp.spawn(ADB, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
    p.on('error', rej);
    p.on('close', code => (code === 0 || opts.ignoreCode ? res(out) : rej(new Error(err.trim() || `adb exited ${code}`))));
    if (opts.onSpawn) opts.onSpawn(p);
  });
}
async function serialFor(deviceName) {
  const out = await adb(['devices', '-l']);
  const list = out.split('\n').slice(1).map(l => l.trim()).filter(l => /\sdevice(\s|$)/.test(l)).map(l => {
    const s = l.split(/\s+/)[0]; const model = (l.match(/model:(\S+)/) || [])[1] || ''; return { s, model };
  });
  if (!list.length) return null;
  if (list.length === 1) return list[0].s;
  const want = String(deviceName).split('+')[0].replace(/\s+/g, '_').toLowerCase();
  for (const d of list) {
    const m = await adb(['-s', d.s, 'shell', 'getprop ro.vivo.market.name; getprop ro.product.model'], { ignoreCode: true }).catch(() => '');
    if (m.toLowerCase().replace(/\s+/g, '_').split('\n').some(x => x && want.includes(x))) return d.s;
  }
  return list.find(d => !d.s.includes(':')) ? list.find(d => !d.s.includes(':')).s : list[0].s;
}
async function listMedia(serial) {
  const roots = MEDIA_ROOTS.map(r => `'${r.replace(/'/g, "'\\''")}'`).join(' ');
  const out = await adb(['-s', serial, 'shell', `find ${roots} -type f ! -path '*/.*' -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`], { ignoreCode: true });
  const files = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\|(\d+)\|(.+)$/);
    if (!m) continue;
    const p = m[3];
    if (!(PHOTO.test(p) || VIDEO.test(p))) continue;
    if (Number(m[1]) === 0) continue;
    files.push({ phonePath: p, size: Number(m[1]), mtime: Number(m[2]) });
  }
  files.sort((a, b) => b.mtime - a.mtime);   // newest first, like the phone gallery
  return files;
}
function freeBytes(dir) {
  try {
    let d = dir; while (d && !fs.existsSync(d)) d = path.dirname(d);
    const out = cp.execFileSync('df', ['-B1', '--output=avail', d || '/'], { encoding: 'utf8' });
    return Number(out.trim().split('\n').pop().trim());
  } catch (_) { return Infinity; }
}

// ---------- backup index (what was already copied) ----------
const sanitize = s => String(s).replace(/[\\/:*?"<>|]/g, '_').trim() || '_';
function deviceDir(d) { return path.join(d.cfg.savePath || path.join(os.homedir(), 'Pictures', 'vivo Backup'), sanitize(d.cfg.deviceName)); }
function indexFile(d) { return path.join(deviceDir(d), '.vivo-backup-index.json'); }
function loadIndex(d) { try { return JSON.parse(fs.readFileSync(indexFile(d), 'utf8')); } catch (_) { return { files: {}, lastBackupTime: -1 }; } }
function saveIndex(d, idx) {
  try { fs.mkdirSync(deviceDir(d), { recursive: true }); const t = indexFile(d) + '.tmp'; fs.writeFileSync(t, JSON.stringify(idx)); fs.renameSync(t, indexFile(d)); }
  catch (e) { log('cannot save index', e.message); }
}
function loadIndexMeta(d) {
  const idx = loadIndex(d);
  if (idx.lastBackupTime > 0) d.info.lastBackupTime = idx.lastBackupTime;
}
const key = f => `${f.phonePath}|${f.size}`;
function isBackedUp(idx, d, f) {
  const e = idx.files[key(f)];
  if (!e) return false;
  try { return fs.statSync(path.join(deviceDir(d), e)).size === f.size; } catch (_) { return false; }
}
function targetFor(d, f) {
  // <device>/<album>/<file>; album = the folder the photo lives in (Camera, Screenshots, WeiXin ...)
  const album = sanitize(path.basename(path.dirname(f.phonePath)));
  let name = sanitize(path.basename(f.phonePath));
  let rel = path.join(album, name), n = 1;
  while (fs.existsSync(path.join(deviceDir(d), rel))) {
    try { if (fs.statSync(path.join(deviceDir(d), rel)).size === f.size) return { rel, exists: true }; } catch (_) {}
    const ext = path.extname(name), base = path.basename(name, ext);
    rel = path.join(album, `${base} (${n++})${ext}`);
  }
  return { rel, exists: false };
}

// ---------- the job ----------
async function start(d) {
  if (d.job) { report(d, {}); return; }
  const job = { cancelled: false, reason: '', child: null };
  d.job = job;
  try {
    if (!d.cfg.savePath) d.cfg.savePath = path.join(os.homedir(), 'Pictures', 'vivo Backup');
    const serial = await serialFor(d.cfg.deviceName);
    if (!serial) { report(d, { status: STATUS.FAILED, errorCode: ERR.PHONE_INFO_FAILED, errorMsg: 'No phone found over USB (adb)' }); return; }
    report(d, { status: STATUS.RECOGNIZING, errorCode: ERR.NONE, errorMsg: '' });
    let files;
    try { files = await listMedia(serial); } catch (e) { report(d, { status: STATUS.FAILED, errorCode: ERR.GET_IMG_INFO_FAILED, errorMsg: e.message }); return; }
    const idx = loadIndex(d);
    // files that already exist in the backup folder (e.g. from an earlier run) count as backed up
    for (const f of files) if (!idx.files[key(f)]) { const t = targetFor(d, f); if (t.exists) idx.files[key(f)] = t.rel; }
    const todo = files.filter(f => !isBackedUp(idx, d, f));
    const done0 = files.length - todo.length;
    log(`device ${d.cfg.deviceName} (${serial}): ${files.length} media files, ${todo.length} not backed up`);
    const base = { totalFileCount: files.length, hasBackupCount: done0, backupIndex: 0, unBackupCount: todo.length };
    if (!d.cfg.isAutoBackup) { saveIndex(d, idx); report(d, Object.assign(base, { status: STATUS.NOT_STARTED })); return; }
    if (!todo.length) {
      idx.lastBackupTime = Date.now(); saveIndex(d, idx);
      report(d, Object.assign(base, { status: STATUS.SUCCESS, lastBackupTime: idx.lastBackupTime })); return;
    }
    report(d, Object.assign(base, { status: STATUS.START }));
    let i = 0, failed = 0, lastSave = Date.now();
    for (const f of todo) {
      if (job.cancelled) break;
      if (freeBytes(deviceDir(d)) < f.size + 64 * 1024 * 1024) {
        saveIndex(d, idx);
        report(d, { status: STATUS.FAILED, errorCode: ERR.COMPUTER_STORAGE_UNENOUGH, errorMsg: 'Not enough PC storage' });
        return;
      }
      const t = targetFor(d, f);
      const dst = path.join(deviceDir(d), t.rel), tmp = dst + '.part';
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        await adb(['-s', serial, 'pull', '-a', f.phonePath, tmp], { onSpawn: c => { job.child = c; } });
        job.child = null;
        if (fs.statSync(tmp).size !== f.size) throw new Error('size mismatch');
        fs.renameSync(tmp, dst);
        try { fs.utimesSync(dst, f.mtime, f.mtime); } catch (_) {}
        idx.files[key(f)] = t.rel;
      } catch (e) {
        job.child = null;
        try { fs.unlinkSync(tmp); } catch (_) {}
        if (job.cancelled) break;
        failed++; log('pull failed', f.phonePath, e.message);
        if (failed > 20 && failed > i / 2) { saveIndex(d, idx); report(d, { status: STATUS.FAILED, errorCode: ERR.IMG_DOWNLOAD_FAILED, errorMsg: e.message }); return; }
      }
      i++;
      report(d, { status: STATUS.DOING, backupIndex: i, unBackupCount: todo.length - i, hasBackupCount: done0 + i - failed });
      if (Date.now() - lastSave > 5000) { saveIndex(d, idx); lastSave = Date.now(); }
    }
    saveIndex(d, idx);
    if (job.cancelled) {
      report(d, { status: job.reason === 'pause' ? STATUS.PAUSED : STATUS.NOT_STARTED, unBackupCount: todo.length - i });
      return;
    }
    idx.lastBackupTime = Date.now(); saveIndex(d, idx);
    report(d, failed
      ? { status: STATUS.FAILED, errorCode: ERR.IMG_DOWNLOAD_FAILED, errorMsg: `${failed} files could not be copied`, unBackupCount: failed, lastBackupTime: idx.lastBackupTime }
      : { status: STATUS.SUCCESS, unBackupCount: 0, hasBackupCount: files.length, lastBackupTime: idx.lastBackupTime });
  } catch (e) {
    log('job error', e.stack || e.message);
    report(d, { status: STATUS.FAILED, errorCode: ERR.CONNECT_ALBUM_FAILED, errorMsg: e.message });
  } finally {
    if (d.job === job) d.job = null;
  }
}
function stop(d, reason) {
  if (!d.job) { if (reason === 'pause') report(d, { status: STATUS.PAUSED }); return; }
  d.job.cancelled = true; d.job.reason = reason || '';
  try { d.job.child && d.job.child.kill(); } catch (_) {}
}
function stopAll() { for (const d of devices.values()) if (d.job) stop(d, 'exit'); }

process.on('SIGTERM', () => { stopAll(); setTimeout(() => process.exit(0), 300); });
process.on('uncaughtException', e => log('uncaught', e.stack || e.message));
log('vivo backup worker (Linux) starting', process.argv.slice(2).join(' '));
// the app sometimes launches the worker twice; the newest one wins, the older one exits
const PIDFILE = path.join(LOGDIR, 'backup-worker.pid');
try {
  const old = Number(fs.readFileSync(PIDFILE, 'utf8'));
  if (old && old !== process.pid && fs.readFileSync(`/proc/${old}/cmdline`, 'utf8').includes('backup-worker.js')) process.kill(old, 'SIGTERM');
} catch (_) {}
try { fs.writeFileSync(PIDFILE, String(process.pid)); } catch (_) {}
connect();
