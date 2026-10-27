// iTunes-style main window for vivo Office Kit on Linux.
//
// The window has iTunes' toolbar, LCD and source list. Its content area shows either the music library
// (our own UI, ui/), the phone's sync pages, a Google service (Google replaces vivo's cloud), or vivo's own
// Office Kit UI. vivo's window can't be re-parented into ours, so it is docked: it becomes a frameless child
// window kept exactly over the content area, and every show/hide/minimize/maximize vivo does to it is
// redirected to this window. PCSUITE_CLASSIC_UI=1 turns all of this off.
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');

const UI = path.join(__dirname, 'ui');
const CFG = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pcsuite');
const GOOGLE_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';
const GOOGLE_HOSTS = /(^|\.)(google\.com|gstatic\.com|googleusercontent\.com|youtube\.com|googleapis\.com|google\.[a-z.]+)$/i;

function install(electron, log = () => {}) {
  const { app, BrowserWindow, BrowserView, ipcMain, protocol, dialog, shell, session, nativeImage, screen } = electron;
  protocol.registerSchemesAsPrivileged([{ scheme: 'vkmedia', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

  const { Library } = require('./library.js');
  const { Devices } = require('./device.js');
  const google = require('../linux/google-services.js');
  let dispatch = null; try { dispatch = require('../linux/exe-dispatch.js'); } catch (_) {}

  let win = null, vivo = null, lib = null, dev = null, gview = null, gkey = null;
  let pane = 'music', rect = null, quitting = false;
  const P = BrowserWindow.prototype;
  const send = (ch, d) => { if (win && !win.isDestroyed()) win.webContents.send(ch, d); };

  // ------------------------------------------------------------ vivo's window: find it and dock it
  app.on('browser-window-created', (_e, w) => {
    w.webContents.on('did-start-navigation', (_ev, url, inPlace, isMain) => {
      if (vivo || !isMain || w === win || !/\/dist\/electron\/index\.html/.test(url)) return;
      adopt(w);
    });
  });
  function adopt(w) {
    vivo = w;
    log('docking vivo main window');
    const redirect = {
      show() { reveal(); }, showInactive() { reveal(); }, focus() { reveal(); }, moveTop() {},
      hide() { if (win) win.hide(); P.hide.call(w); },
      minimize() { if (win) win.minimize(); },
      maximize() { if (win) win.maximize(); }, unmaximize() { if (win) win.unmaximize(); },
      isMaximized() { return win ? win.isMaximized() : false; }, isMinimized() { return win ? win.isMinimized() : false; },
      isVisible() { return win ? win.isVisible() : false; }, isFocused() { return win ? (win.isFocused() || P.isFocused.call(w)) : false; },
      restore() { if (win) { win.restore(); reveal(); } },
      setFullScreen(f) { if (win) win.setFullScreen(f); }, isFullScreen() { return win ? win.isFullScreen() : false; },
    };
    for (const m of ['setSize', 'setBounds', 'setPosition', 'center', 'setMinimumSize', 'setMaximumSize', 'setResizable', 'setContentSize', 'setAlwaysOnTop', 'setSkipTaskbar', 'setMovable'])
      redirect[m] = () => {};
    Object.assign(w, redirect);
    try { P.setSkipTaskbar.call(w, true); P.setResizable.call(w, true); P.setMinimumSize.call(w, 200, 200); P.setMaximumSize.call(w, 10000, 10000); } catch (_) {}
    P.hide.call(w);
    if (win) { P.setParentWindow.call(w, win); dock(); }
    w.on('closed', () => { vivo = null; if (!quitting && win && !win.isDestroyed()) { quitting = true; app.quit(); } });
    w.webContents.on('dom-ready', () => tidyVivo());
  }
  function reveal() {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show(); win.focus(); dock();
  }
  function dock() {
    if (!vivo || vivo.isDestroyed() || !win) return;
    const show = pane === 'office' && rect && win.isVisible() && !win.isMinimized();
    if (process.env.PCSUITE_DEBUG) log(`dock: pane=${pane} show=${!!show} rect=${JSON.stringify(rect)} vivoVisible=${P.isVisible.call(vivo)}`);
    if (show) {
      const cb = win.getContentBounds();
      const b = { x: Math.round(cb.x + rect.x), y: Math.round(cb.y + rect.y), width: Math.max(200, Math.round(rect.width)), height: Math.max(200, Math.round(rect.height)) };
      P.setBounds.call(vivo, b);
      if (!P.isVisible.call(vivo)) { P.showInactive.call(vivo); P.setBounds.call(vivo, b); P.moveTop.call(vivo); }
      if (process.env.PCSUITE_DEBUG) log(`dock: shown=${P.isVisible.call(vivo)} bounds=${JSON.stringify(P.getBounds.call(vivo))} min=${P.isMinimized.call(vivo)}`);
    } else if (P.isVisible.call(vivo)) P.hide.call(vivo);
  }
  // hide vivo's own left navigation while docked (our source list has the same entries) and navigate it
  function tidyVivo() {
    if (!vivo || lib.db.settings.vivoSidebar) return;
    vivo.webContents.executeJavaScript(`(() => {
      if (window.__vkTidy) return; window.__vkTidy = true;
      const NAV = ['Home', 'Notes', 'Calendar', 'Albums', 'Recorder', 'Settings', '首页', '便签', '日历', '相册', '录音', '设置'];
      const find = () => {
        const hits = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.children.length > 2) continue;
          const t = (el.innerText || '').trim();
          if (NAV.includes(t)) { const r = el.getBoundingClientRect(); if (r.width && r.left < 240) hits.push(el); }
        }
        if (hits.length < 3) return null;
        let a = hits[0];
        while (a && !hits.every(h => a.contains(h))) a = a.parentElement;
        while (a && a.parentElement && a.parentElement.getBoundingClientRect().width < 280) a = a.parentElement;
        return a && a !== document.body && a.getBoundingClientRect().width < 280 ? a : null;
      };
      let tries = 0, t = 0;
      const check = () => { const nav = find(); if (nav || ++tries > 60) { clearInterval(t); if (nav) { nav.setAttribute('data-vk-nav', ''); nav.style.setProperty('display', 'none', 'important'); } return true; } };
      if (!check()) t = setInterval(check, 500);
    })();`, true).catch(() => {});
  }
  function officeNav(label) {
    if (!vivo) return;
    const labels = { home: ['Home', '首页'], connect: ['Connect', '连接', '添加设备'], notes: ['Notes', '便签', '笔记'], calendar: ['Calendar', '日历'],
      albums: ['Albums', '相册'], recorder: ['Recorder', '录音'], tools: ['Tools', '工具'], settings: ['Settings', '设置'] }[label] || [label];
    vivo.webContents.executeJavaScript(`(() => {
      const L = ${JSON.stringify(labels)};
      const root = document.querySelector('[data-vk-nav]') || document.body;
      for (const el of root.querySelectorAll('*')) {
        if (el.children.length > 2) continue;
        if (L.includes((el.textContent || '').trim())) { (el.closest('[role=button],a,li,button') || el).click(); return true; }
      }
      return false;
    })();`, true).catch(() => {});
  }

  // ------------------------------------------------------------ Google pane
  function googleView() {
    if (gview) return gview;
    const ses = session.fromPartition('persist:google');
    ses.setUserAgent(GOOGLE_UA);
    gview = new BrowserView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    gview.setBackgroundColor('#ffffff');
    const wc = gview.webContents;
    wc.setUserAgent(GOOGLE_UA);
    wc.setWindowOpenHandler(({ url }) => {
      try { if (GOOGLE_HOSTS.test(new URL(url).hostname)) { wc.loadURL(url); return { action: 'deny' }; } } catch (_) {}
      shell.openExternal(url); return { action: 'deny' };
    });
    const state = () => send('google:state', { key: gkey, url: wc.getURL(), title: wc.getTitle(), back: wc.canGoBack(), fwd: wc.canGoForward(), loading: wc.isLoading() });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) wc.on(ev, state);
    return gview;
  }
  function placeGoogle() {
    if (!win) return;
    const show = pane.startsWith('google:') && rect;
    if (show) {
      const v = googleView();
      if (!win.getBrowserViews().includes(v)) win.addBrowserView(v);
      const top = 36;   // the Google page's own back/reload bar is drawn by the UI above the view
      v.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y + top), width: Math.round(rect.width), height: Math.max(100, Math.round(rect.height - top)) });
      const k = pane.slice(7);
      if (k !== gkey) { gkey = k; v.webContents.loadURL(google.SERVICES[k].url); }
    } else if (gview && win.getBrowserViews().includes(gview)) win.removeBrowserView(gview);
  }
  function layout() { dock(); placeGoogle(); }

  // ------------------------------------------------------------ window
  function createWindow() {
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const st = lib.db.settings.window || {};
    win = new BrowserWindow({
      width: Math.min(st.width || 1440, wa.width), height: Math.min(st.height || 900, wa.height), x: st.x, y: st.y,
      minWidth: 900, minHeight: 560, frame: false, show: false, title: 'vivo Office Kit', backgroundColor: '#f6f6f6',
      icon: path.join(path.dirname(app.getPath('exe')), 'logo.png'),
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false, nodeIntegration: false, backgroundThrottling: false },
    });
    win.loadURL('vkmedia://app/shell.html');
    win.once('ready-to-show', () => { if (st.maximized) win.maximize(); win.show(); });
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('vkmedia://app/')) { e.preventDefault(); shell.openExternal(url); } });
    for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'show', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => { layout(); send('app:maximized', win.isMaximized()); });
    // keep the docked Office Kit window above ours (window managers do this for child windows; some don't)
    win.on('focus', () => { if (pane === 'office' && vivo && !vivo.isDestroyed() && P.isVisible.call(vivo)) P.moveTop.call(vivo); });
    for (const ev of ['minimize', 'hide']) win.on(ev, () => { if (vivo && !vivo.isDestroyed()) P.hide.call(vivo); });
    const saveBounds = () => { if (!win.isMaximized() && !win.isMinimized()) lib.setSettings({ window: Object.assign(win.getBounds(), { maximized: false }) }); else lib.setSettings({ window: Object.assign({}, lib.db.settings.window, { maximized: win.isMaximized() }) }); };
    win.on('resized', saveBounds); win.on('moved', saveBounds); win.on('maximize', saveBounds); win.on('unmaximize', saveBounds);
    win.on('close', e => {
      if (quitting) return;
      // like vivo's own close button: keep running in the tray (vivo decides), otherwise quit
      e.preventDefault();
      if (vivo && !vivo.isDestroyed()) { win.hide(); try { P.close.call(vivo); } catch (_) {} }
      else { quitting = true; app.quit(); }
    });
    if (vivo) { P.setParentWindow.call(vivo, win); }
    google.setOpener(k => { reveal(); setPane('google:' + k); send('app:pane', 'google:' + k); });
  }
  function setPane(p) { pane = p; layout(); }
  app.on('before-quit', () => { quitting = true; });

  // ------------------------------------------------------------ protocol: UI files, songs, artwork
  const temp = new Map();
  // A stream handler (not registerFileProtocol: Electron 22's file handler fails on non-ASCII paths like "Oxygène"),
  // with HTTP range support so seeking works.
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg', '.png': 'image/png', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.m4b': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac',
    '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm' };
  function serve(req, file, cb, extra = {}) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return cb({ statusCode: 404, headers: { 'Content-Type': 'text/plain' }, data: null });
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      const range = /bytes=(\d*)-(\d*)/.exec((req.headers && (req.headers.Range || req.headers.range)) || '');
      const headers = Object.assign({ 'Content-Type': type, 'Accept-Ranges': 'bytes' }, extra);
      if (range && st.size) {
        let start = range[1] ? +range[1] : st.size - +range[2], end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
        if (!range[1]) end = st.size - 1;
        if (start >= st.size || start < 0) return cb({ statusCode: 416, headers: { 'Content-Range': `bytes */${st.size}` }, data: null });
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`; headers['Content-Length'] = String(end - start + 1);
        return cb({ statusCode: 206, headers, data: fs.createReadStream(file, { start, end }) });
      }
      headers['Content-Length'] = String(st.size);
      cb({ statusCode: 200, headers, data: fs.createReadStream(file) });
    });
  }
  function registerProtocol() {
    protocol.registerStreamProtocol('vkmedia', (req, cb) => {
      try {
        const u = new URL(req.url), p = decodeURIComponent(u.pathname.slice(1));
        if (u.host !== 'app') return cb({ statusCode: 404, data: null });
        // everything is on one origin (vkmedia://app) so the player's equalizer can read the audio
        const [kind, ...rest] = p.split('/'), arg = rest.join('/');
        if (kind === '~track') { const t = lib.track(arg); return t ? serve(req, t.path, cb) : cb({ statusCode: 404, data: null }); }
        if (kind === '~art') return serve(req, path.join(lib.artDir, path.basename(arg) + '.jpg'), cb, { 'Cache-Control': 'max-age=3600' });
        if (kind === '~temp') { const f = temp.get(arg); return f ? serve(req, f, cb) : cb({ statusCode: 404, data: null }); }
        const f = path.normalize(path.join(UI, p || 'shell.html'));
        if (!f.startsWith(UI + path.sep)) return cb({ statusCode: 403, data: null });
        return serve(req, f, cb);
      } catch (e) { log('protocol: ' + e.message); cb({ statusCode: 500, data: null }); }
    });
  }

  // ------------------------------------------------------------ IPC
  function ipc() {
    const h = (ch, f) => ipcMain.handle(ch, async (_e, ...a) => { try { return await f(...a); } catch (e) { log(`${ch}: ${e.stack || e}`); throw e; } });
    h('lib:get', () => Object.assign(lib.snapshot(), { services: google.SERVICES, platform: { ffmpeg: hasBin('ffmpeg'), home: os.homedir() } }));
    h('lib:scan', () => lib.scan());
    h('lib:addFolder', async () => { const r = await dialog.showOpenDialog(win, { title: 'Add Folder to Library', properties: ['openDirectory', 'multiSelections'] }); if (r.canceled) return null; for (const d of r.filePaths) await lib.addFolder(d); return r.filePaths; });
    h('lib:addFiles', async () => {
      const r = await dialog.showOpenDialog(win, { title: 'Add to Library', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'wma', 'm4b'] }] });
      return r.canceled ? null : lib.scan(r.filePaths);
    });
    h('lib:addPaths', paths => lib.scan(paths.filter(p => typeof p === 'string' && fs.existsSync(p))));
    h('lib:removeFolder', d => lib.removeFolder(d));
    h('lib:update', (ids, f) => { lib.update(ids, pick(f, ['rating', 'loved'])); return true; });
    h('lib:editTags', (ids, f, write) => lib.editTags(ids, pick(f, ['title', 'artist', 'albumArtist', 'album', 'genre', 'year', 'track', 'trackTotal', 'disc', 'discTotal', 'composer', 'comment', 'compilation']), write));
    h('lib:setArtwork', async ids => { const r = await dialog.showOpenDialog(win, { title: 'Choose Artwork', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] }); if (r.canceled) return false; await lib.setArtwork(ids, r.filePaths[0]); return true; });
    h('lib:remove', async (ids, trash) => {
      const files = ids.map(i => lib.track(i)).filter(Boolean).map(t => t.path);
      lib.remove(ids);
      if (trash) for (const f of files) await shell.trashItem(f).catch(e => log('trash: ' + e.message));
      return true;
    });
    h('lib:played', id => lib.played(id));
    h('lib:skipped', id => lib.skipped(id));
    h('lib:setPlaylists', pl => lib.setPlaylists(pl));
    h('lib:setSettings', s => { const r = lib.setSettings(s); if ('vivoSidebar' in s && vivo) vivo.webContents.executeJavaScript(`document.querySelectorAll('[data-vk-nav]').forEach(n => n.style.display = ${s.vivoSidebar ? "''" : "'none'"})`).catch(() => {}); if (!s.vivoSidebar && 'vivoSidebar' in s) tidyVivo(); return r; });
    h('lib:show', id => { const t = lib.track(id); if (t) shell.showItemInFolder(t.path); });
    h('lib:openFolder', d => shell.openPath(d));

    h('dev:list', () => ({ list: dev.publicList(), adbMissing: dev.adbMissing, syncing: !!dev.sync }));
    h('dev:refresh', (s, usage) => dev.refreshInfo(s, usage));
    h('dev:settings', (s, d) => { const r = lib.setDevice(s, d); send('dev:devices', { list: dev.publicList() }); return r; });
    h('dev:plan', (s, resolved) => { const p = dev.plan(s, resolved); return { count: p.count, bytes: p.bytes }; });
    h('dev:sync', (s, resolved, defs) => { dev.startSync(s, resolved, defs).catch(e => log('sync: ' + e.message)); return true; });
    h('dev:cancel', () => dev.cancelSync());
    h('dev:phoneMusic', s => dev.phoneMusic(s));
    h('dev:delete', (s, paths) => dev.deleteFromPhone(s, paths));
    h('dev:import', async (s, paths) => {
      const root = lib.db.folders[0] || path.join(os.homedir(), 'Music');
      const r = await dev.importFromPhone(s, paths, root, d => send('dev:sync', Object.assign({ serial: s, label: `Importing ${d.i} of ${d.n}`, title: d.title, i: d.i, n: d.n })));
      send('dev:sync', { serial: s, done: true, label: 'Import complete', copied: r.files.length });
      if (!lib.db.folders.includes(root)) await lib.addFolder(root); else await lib.scan(r.files);
      return r.files.length;
    });
    h('dev:preview', async (s, p) => { const f = await dev.pullTemp(s, p); const k = path.basename(f); temp.set(k, f); return 'vkmedia://app/~temp/' + encodeURIComponent(k); });

    h('app:pane', (p, r) => { if (r) rect = r; setPane(p); return true; });
    h('app:rect', r => { rect = r; layout(); });
    h('app:office', label => { officeNav(label); });
    h('app:launch', kind => {
      if (kind === 'drive') { const d = process.env.PCSUITE_MOUNT_DIR || path.join(os.homedir(), 'vivo Phone'); return shell.openPath(d).then(e => !e); }
      return dispatch ? dispatch.launch(kind) : false;
    });
    h('app:win', a => {
      if (a === 'min') win.minimize(); else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (a === 'close') win.close(); else if (a === 'quit') { quitting = true; app.quit(); }
      else if (a === 'devtools') win.webContents.openDevTools({ mode: 'detach' });
      return win.isMaximized();
    });
    h('app:google', cmd => {
      const wc = gview && gview.webContents; if (!wc) return;
      if (cmd === 'back' && wc.canGoBack()) wc.goBack(); else if (cmd === 'forward' && wc.canGoForward()) wc.goForward();
      else if (cmd === 'reload') wc.reload(); else if (cmd === 'home' && gkey) wc.loadURL(google.SERVICES[gkey].url);
      else if (cmd === 'external') shell.openExternal(wc.getURL() || google.SERVICES[gkey].url);
      else if (cmd === 'signout') session.fromPartition('persist:google').clearStorageData().then(() => { gkey = null; placeGoogle(); });
    });
    h('app:external', u => /^https?:/.test(u) && shell.openExternal(u));
    h('app:logs', () => shell.openPath(path.join(CFG, 'log')));
    h('app:popupMenu', () => {});
  }
  const pick = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)));
  const bins = {};
  function hasBin(b) { if (!(b in bins)) try { cp.execFileSync('sh', ['-c', `command -v ${b}`], { stdio: 'ignore' }); bins[b] = true; } catch (_) { bins[b] = false; } return bins[b]; }

  app.whenReady().then(() => {
    try {
      lib = new Library(path.join(CFG, 'music'), { nativeImage, log });
      dev = new Devices(lib, { log });
      lib.on((ev, d) => send(ev === 'tracks' ? 'lib:tracks' : 'lib:scan', d));
      dev.on((ev, d) => send(ev === 'devices' ? 'dev:devices' : 'dev:sync', d));
      registerProtocol(); ipc(); createWindow();
      dev.start();
      setTimeout(() => lib.scan().catch(e => log('scan: ' + e.message)), 1500);
    } catch (e) { log('music window: ' + e.stack); }
  });
}

module.exports = { install };
