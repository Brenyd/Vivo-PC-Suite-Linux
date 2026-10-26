// Linux implementation of vivo's native "electron-dragfile" addon (Windows-only in the original).
// Same function names and return formats; uses standard Linux tools (df, xdg-open, gio, dbus).
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const run = (cmd, args, opts = {}) => {
  try { return cp.execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, ...opts }); }
  catch (_) { return null; }
};
const detached = (cmd, args) => {
  try { const p = cp.spawn(cmd, args, { detached: true, stdio: 'ignore' }); p.on('error', () => {}); p.unref(); return true; }
  catch (_) { return false; }
};
const df = p => {
  // returns {size, used, avail} in bytes for the filesystem holding p
  let dir = p;
  while (dir && !fs.existsSync(dir)) dir = path.dirname(dir);
  const out = run('df', ['-B1', '--output=size,used,avail', dir || '/']);
  if (!out) return null;
  const [size, used, avail] = out.trim().split('\n').pop().trim().split(/\s+/).map(Number);
  return { size, used, avail };
};
function mimeOf(ext) {
  try { return require('mime-types').lookup(ext) || null; } catch (_) { return null; }
}
function desktopFileFor(id) {
  const dirs = [path.join(os.homedir(), '.local/share/applications'), '/usr/local/share/applications',
    '/usr/share/applications', '/var/lib/flatpak/exports/share/applications',
    path.join(os.homedir(), '.local/share/flatpak/exports/share/applications')];
  for (const d of dirs) { const f = path.join(d, id); if (fs.existsSync(f)) return f; }
  return null;
}
function desktopName(file) {
  try { const m = fs.readFileSync(file, 'utf8').match(/^Name=(.*)$/m); return m ? m[1] : path.basename(file, '.desktop'); }
  catch (_) { return path.basename(file, '.desktop'); }
}
function openWith(file, appPath) {
  if (appPath && /\.desktop$/.test(appPath)) {
    const df = fs.existsSync(appPath) ? appPath : desktopFileFor(appPath);
    if (df && (detached('gio', ['launch', df, file]) || detached('kioclient', ['exec', df, file]))) return true;
  } else if (appPath && fs.existsSync(appPath)) {
    return detached(appPath, [file]);
  }
  return detached('xdg-open', [file]);
}

module.exports = {
  // Drag phone files out of the app onto the desktop / a file manager. On Windows this is a
  // "virtual file" drag that downloads on drop; on Linux we drag the file's path inside the
  // mounted phone drive (phone-drive.js), so the drop target streams it straight from the phone.
  startDrag(dragItem) {
    try {
      const drive = require('./phone-drive.js');
      const { BrowserWindow, nativeImage } = require('electron');
      const files = (dragItem && dragItem.files || [])
        .map(f => drive.localPath(f.phonePath || f.savePath || f.path, null) || (f.pcPath && fs.existsSync(f.pcPath) ? f.pcPath : null))
        .filter(p => p && fs.existsSync(p));
      if (!files.length) {
        console.warn('[linux dragfile] nothing to drag (phone drive not mounted?)');
        return false;
      }
      const win = BrowserWindow.getFocusedWindow() || global.__mainWindow;
      let icon = dragItem.dragImage && fs.existsSync(dragItem.dragImage) ? nativeImage.createFromPath(dragItem.dragImage) : null;
      if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(path.dirname(process.execPath), 'logo.png'));
      win && win.webContents.startDrag({ file: files[0], files, icon: icon.resize({ width: 64 }) });
      return true;
    } catch (e) { console.warn('[linux dragfile] startDrag failed: ' + e.message); return false; }
  },
  cancel() {}, stop() {}, enter() {}, leave() {},

  getAvailableSpace(p) { const d = df(p); return d ? d.avail : 0; },
  getDiskInfo(p) {
    const d = df(p) || { size: 0, used: 0, avail: 0 };
    return JSON.stringify({ totalSpace: d.size, usedSpace: d.used, usableSpace: d.avail });
  },
  getFolderInfo(dir, cb) {
    setImmediate(() => {
      let totalSize = 0, fileCount = 0, folderCount = 0;
      const walk = d => {
        let list = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
        for (const e of list) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) { folderCount++; walk(f); }
          else if (e.isFile()) { fileCount++; try { totalSize += fs.statSync(f).size; } catch (_) {} }
        }
      };
      try {
        if (fs.statSync(dir).isDirectory()) walk(dir); else { fileCount = 1; totalSize = fs.statSync(dir).size; }
        cb(JSON.stringify({ result: 0, reason: '', totalSize, fileCount, folderCount }));
      } catch (e) { cb(JSON.stringify({ result: 1, reason: String(e.message || e), totalSize: 0, fileCount: 0 })); }
    });
  },

  getFileExtSupportApp(ext) {
    const mime = mimeOf(ext);
    const id = mime && (run('xdg-mime', ['query', 'default', mime]) || '').trim();
    const file = id && desktopFileFor(id);
    return JSON.stringify(file ? [{ appName: desktopName(file), appPath: file, isDefault: 1 }] : []);
  },
  openFile(file, appPath) { return openWith(file, appPath); },
  openFileAsync(file, appPath) { return Promise.resolve(openWith(file, appPath)); },
  openFolderAndSelectItems(arg) {
    let files = [];
    try { const o = typeof arg === 'string' ? JSON.parse(arg) : arg; files = o.files || [o.path || o.dir].filter(Boolean); }
    catch (_) { files = [String(arg)]; }
    files = files.map(f => (typeof f === 'string' ? f : f.path || f.filePath)).filter(Boolean);
    if (!files.length) return false;
    const uris = files.map(f => 'file://' + encodeURI(f).replace(/#/g, '%23'));
    // Freedesktop FileManager1 (Dolphin, Nautilus, Nemo...) highlights the files
    const ok = run('dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.FileManager1',
      '/org/freedesktop/FileManager1', 'org.freedesktop.FileManager1.ShowItems',
      `array:string:${uris.join(',')}`, 'string:']) !== null;
    return ok || detached('xdg-open', [fs.statSync(files[0]).isDirectory() ? files[0] : path.dirname(files[0])]);
  },
  launch(cmd) { return detached('/bin/sh', ['-c', String(cmd)]); },
  openUrl(url) { return detached('xdg-open', [String(url)]); },
  processIsExist(name) { return run('pgrep', ['-x', String(name).replace(/\.exe$/i, '').slice(0, 15)]) !== null; },
  esServiceIsExist() { return false; },
  syncServiceIsExist() {
    // vivo's cloud-sync service would listen on 127.0.0.1:9996 (not available on Linux)
    try {
      return ['/proc/net/tcp', '/proc/net/tcp6'].some(f => fs.existsSync(f) &&
        fs.readFileSync(f, 'utf8').split('\n').some(l => { const c = l.trim().split(/\s+/); return c[1] && c[1].endsWith(':270C') && c[3] === '0A'; }));
    } catch (_) { return false; }
  },
  queryPCSuiteInfo() {},
  getUserGeoName() {
    // Country of the user (vivo reads it from Windows' region setting). PCSUITE_COUNTRY overrides it;
    // the China edition defaults to CN so phones/accounts from mainland China use the right servers.
    if (process.env.PCSUITE_COUNTRY) return process.env.PCSUITE_COUNTRY.toUpperCase();
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(process.resourcesPath || '', 'build-config.json'), 'utf8'));
      if (cfg.IS_EXPORT === false) return 'CN';
    } catch (_) {}
    const loc = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '';
    const m = loc.match(/^[a-z]{2,3}_([A-Z]{2})/);
    return m ? m[1] : '';
  },
  getOSInfo() {
    const rel = os.release();
    let pretty = 'Linux';
    try { const m = fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)"?/m); if (m) pretty = m[1]; } catch (_) {}
    return JSON.stringify({ os: { name: pretty, version: rel.split('-')[0], type: 0, arch: os.arch() } });
  },
};

// Voice-recorder audio engine (vaudio_kernel.dll) – not available on Linux; same no-op fallback vivo uses on macOS.
for (const k of ['Init', 'CreatePlayer', 'StartPlay', 'DestroyPlayer', 'GetAudioDuration', 'GetAudioDeviceList',
  'GetPlayState', 'PausePlay', 'ResumePlay', 'StopPlay', 'SeekPlay', 'SetSkipSilence', 'SetPlaySpeed', 'SetLoopPlay',
  'CreateProcessor', 'TranscodeAudio', 'CancelTranscode', 'DestroyProcessor', 'DestroyAllPlayers'])
  module.exports['VAudioKernel_' + k] = () => {};
