// Opens a folder in a real file manager. xdg-open isn't enough: on some desktops the default app for folders
// ends up being an image viewer (Gwenview), which shows the phone's folders but none of its files.
// Order: the default folder app if it's a file manager -> the first installed file manager -> FileManager1 over D-Bus.
'use strict';
const cp = require('child_process');

// someone with Nemo installed on KDE chose it on purpose, so it goes before Dolphin
const FILE_MANAGERS = ['nemo', 'dolphin', 'nautilus', 'thunar', 'pcmanfm-qt', 'pcmanfm', 'caja', 'krusader', 'spacefm'];
const has = bin => { try { cp.execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch (_) { return false; } };
const run = (bin, args) => { const p = cp.spawn(bin, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); };

function defaultApp() {
  try { return cp.execFileSync('xdg-mime', ['query', 'default', 'inode/directory'], { encoding: 'utf8', timeout: 3000 }).trim().replace(/\.desktop$/, ''); }
  catch (_) { return ''; }
}

function openFolder(dir, log = () => {}) {
  const def = defaultApp();
  const fm = FILE_MANAGERS.find(f => def.toLowerCase().includes(f) && has(f)) || FILE_MANAGERS.find(has);
  if (fm) { log(`open-folder: ${fm} ${dir}${def && !def.toLowerCase().includes(fm) ? ` (default folder app "${def}" is not a file manager)` : ''}`); run(fm, [dir]); return true; }
  try {
    cp.execFileSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.FileManager1', '--object-path', '/org/freedesktop/FileManager1',
      '--method', 'org.freedesktop.FileManager1.ShowFolders', `['file://${encodeURI(dir)}']`, ''], { stdio: 'ignore', timeout: 5000 });
    log(`open-folder: FileManager1 ${dir}`);
    return true;
  } catch (_) {}
  run('xdg-open', [dir]);
  return true;
}

module.exports = { openFolder };
