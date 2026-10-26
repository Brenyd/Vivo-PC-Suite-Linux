// Linux implementation of vivo's "filesearch" addon (Windows: Everything search engine; macOS: Spotlight).
// Searches local files with plocate/locate when available, otherwise a bounded `find` in $HOME.
'use strict';
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');

const MAX = 2000;
let results = [], cursor = 0, pageSize = 50, gen = 0;

const has = bin => { try { cp.execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const locateBin = ['plocate', 'locate'].find(has);

function toItem(full) {
  try {
    const st = fs.statSync(full);
    let subCount = 0;
    if (st.isDirectory()) { try { subCount = fs.readdirSync(full).length; } catch (_) {} }
    return { fullPathName: full, fileName: path.basename(full), path: path.dirname(full), isFile: st.isFile(),
      size: st.size, fileSize: st.size, subCount, dateModified: st.mtimeMs, dateCreated: st.birthtimeMs || st.ctimeMs };
  } catch (_) { return null; }
}

function runSearch(params, done) {
  const key = String(params.searchKey || '').trim();
  const dirs = (params.searchPaths || []).filter(Boolean);
  const excl = (params.excludePaths || []).filter(Boolean);
  const hidden = p => /\/\.[^/]/.test(p.slice(os.homedir().length)) || excl.some(e => p.startsWith(e));
  // Folder listing mode
  if (!key && dirs.length) {
    let list = [];
    for (const d of dirs) { try { list = list.concat(fs.readdirSync(d).filter(n => !n.startsWith('.')).map(n => path.join(d, n))); } catch (_) {} }
    return done(list);
  }
  if (!key) return done([]);
  const roots = dirs.length ? dirs : [os.homedir()];
  let cmd, args;
  if (locateBin && !dirs.length) { cmd = locateBin; args = ['-i', '-l', String(MAX * 2), '--', key]; }
  else {
    cmd = 'find'; args = [...roots, '-xdev', '(', '-name', '.*', '-prune', ')', '-o', '-iname', `*${key}*`, '-print'];
  }
  let out = '';
  const p = cp.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
  const timer = setTimeout(() => p.kill(), 8000);
  p.stdout.on('data', d => { out += d; if (out.length > 4e6) p.kill(); });
  p.on('error', () => { clearTimeout(timer); done([]); });
  p.on('close', () => {
    clearTimeout(timer);
    const homeFirst = out.split('\n').filter(Boolean)
      .filter(f => !hidden(f) && (!locateBin || roots.some(r => f.startsWith(r)) || !dirs.length))
      .filter(f => path.basename(f).toLowerCase().includes(key.toLowerCase()))
      .sort((a, b) => (b.startsWith(os.homedir()) - a.startsWith(os.homedir())));
    done(homeFirst.slice(0, MAX));
  });
}

function page(cb) {
  const slice = results.slice(cursor, cursor + pageSize).map(toItem).filter(Boolean);
  cursor += pageSize;
  setImmediate(() => cb(slice));
}

module.exports = {
  init() { return true; }, uninit() {},
  startQuery(params = {}, cb = () => {}) {
    const my = ++gen;
    pageSize = Number(params.pageSize) || 50; cursor = 0; results = [];
    runSearch(params, list => {
      if (my !== gen) return;
      results = list;
      if (Number(params.sortType) === 1) results.sort();       // by name
      page(cb);
    });
  },
  queryNext(cb = () => {}) { page(cb); },
  stopQuery() { gen++; },
  getThumbnail(filePath, saveFileName, h, w, cb) { if (cb) setImmediate(() => cb('')); },   // UI falls back to type icons
  showFileInfo(file) {
    try {
      cp.spawn('dbus-send', ['--session', '--dest=org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1.ShowItemProperties', `array:string:file://${encodeURI(file)}`, 'string:'],
        { stdio: 'ignore', detached: true }).unref();
    } catch (_) {}
  },
  everythingIsRunning() { return true; },
  everythingServiceIsRunning() { return true; },
  startEverything() { return true; },
  everythingIsDBLoaded() { return true; },
  hasNTFSDriver() { return false; },
  moveFileToTrash(files, _hwnd, cb) {
    const { shell } = require('electron');
    Promise.allSettled((files || []).map(f => shell.trashItem(f))).then(r => cb && cb(r));
  },
  clearThumbnail() {},
  checkFullDiskAccess() { return true; },
  requestAuthorization() {},
};
