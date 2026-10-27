// vivo PC Suite – Linux bootstrap. Installs compatibility shims, then loads vivo's main bundle.
const fs = require('fs'), util = require('util'), path = require('path'), Module = require('module');
// Log file for the Linux layer: ~/.config/pcsuite/log/linux.log (recreated each start).
// PCSUITE_DEBUG=1 also mirrors all of vivo's console output into it.
const LOG = process.env.PCSUITE_BOOTLOG || path.join(process.env.XDG_CONFIG_HOME || path.join(require('os').homedir(), '.config'), 'pcsuite', 'log', 'linux.log');
try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.writeFileSync(LOG, ''); } catch (_) {}
const w = (lvl, a) => { try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${lvl} ${util.format(...a)}\n`); } catch (_) {} };
if (process.env.PCSUITE_DEBUG)
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { const o = console[k]; console[k] = (...a) => { w(k, a); try { o.apply(console, a); } catch (_) {} }; }
process.on('uncaughtException', e => w('UNCAUGHT', [e && e.stack || e]));
process.on('unhandledRejection', e => w('UNHANDLED', [e && e.stack || e]));
w('boot', ['electron', process.versions.electron]);

// ---- Electron APIs that only exist on Windows/macOS
const electron = require('electron');
if (process.env.PCSUITE_DEBUG_PORT) electron.app.commandLine.appendSwitch('remote-debugging-port', process.env.PCSUITE_DEBUG_PORT);
const sp = electron.systemPreferences;
const def = (o, k, v) => { if (o && typeof o[k] !== 'function') try { o[k] = v; } catch (e) { w('shim', ['cannot define', k, e.message]); } };
def(sp, 'isAeroGlassEnabled', () => false);
def(sp, 'getAccentColor', () => '2b6cfaff');
def(sp, 'getColor', () => '#ffffff');
def(sp, 'isSwipeTrackingFromScrollEventsEnabled', () => false);
def(sp, 'getMediaAccessStatus', () => 'granted');
def(sp, 'askForMediaAccess', async () => true);

// BrowserWindow methods that only exist on Windows/macOS builds of Electron
const BWP = electron.BrowserWindow && electron.BrowserWindow.prototype;
for (const m of ['setThumbnailClip', 'setThumbarButtons', 'setAppDetails', 'hookWindowMessage',
                 'unhookWindowMessage', 'isWindowMessageHooked', 'unhookAllWindowMessages',
                 'setWindowButtonVisibility', 'setTrafficLightPosition', 'setVibrancy',
                 'setTouchBar', 'setSheetOffset', 'setRepresentedFilename', 'setDocumentEdited',
                 'setThumbnailToolTip', 'setOverlayIcon', 'setBackgroundMaterial'])
  def(BWP, m, function () { return m === 'setThumbarButtons' || m === 'setThumbnailClip'; });
def(electron.app, 'setUserTasks', () => true);
def(electron.app, 'setJumpList', () => 'ok');
def(electron.app, 'setAppUserModelId', () => {});

// ---- Windows-only native modules -> logging stubs
const stubbed = new Set((process.env.PCSUITE_STUBS || 'node-windows,@xan105/win-verify-trust').split(','));
function makeStub(name, p = name) {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, k) {
      if (k === '__esModule') return false;
      if (k === 'then') return undefined;               // not a thenable
      if (k === Symbol.toPrimitive) return () => '';
      if (typeof k === 'symbol') return undefined;
      return makeStub(name, `${p}.${String(k)}`);
    },
    apply(_t, _this, args) { w('stub', [`${p}(${args.map(a => typeof a).join(',')})`]); return undefined; },
    construct() { w('stub', [`new ${p}`]); return makeStub(name, `${p}#inst`); },
  });
}
const overrides = {};
try { Object.assign(overrides, require('./linux/overrides.js')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') w('boot', ['overrides failed', e.stack]); }
if (overrides.regedit) global.__linuxRegedit = overrides.regedit;
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (overrides[req]) return overrides[req];
  if (stubbed.has(req)) { w('stub', ['require', req]); return (overrides[req] = makeStub(req)); }
  return origLoad.apply(this, arguments);
};

// ---- First-run files the Windows installer would normally create (%APPDATA%\pcsuite)
(function seedAppData() {
  const os = require('os');
  const root = path.join(electron.app.getPath('appData'), 'pcsuite');
  for (const d of ['', 'database', 'log', 'RightClickMenu']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const ini = path.join(root, 'config.ini');
  const lang = process.env.PCSUITE_LANG || 'en_US';
  let txt = fs.existsSync(ini) ? fs.readFileSync(ini, 'utf8') : '';
  if (!/^\[PCSuite\]/m.test(txt)) txt = `[PCSuite]\nSyncServicePort=9996\nhostName=${os.hostname()}\n[Hardware]\n[OS]\n` + txt;
  // Force the UI language (English by default) on every start.
  if (/^LanguageTag=.*$/m.test(txt)) txt = txt.replace(/^LanguageTag=.*$/m, `LanguageTag=${lang}`);
  else txt = txt.replace(/^\[PCSuite\]\s*$/m, `[PCSuite]\nLanguageTag=${lang}`);
  fs.writeFileSync(ini, txt);

  // Local databases (Notes, Calendar, Albums, Recorder, settings) are normally created by
  // vivoSyncService.exe. Create/upgrade them the same way, synchronously, before vivo's code runs.
  try {
    const r = require('child_process').spawnSync(process.execPath,
      [path.join(__dirname, 'linux', 'db-init.js'), path.join(process.resourcesPath, 'sqlite3', 'node_sqlite3.node'), path.join(root, 'database')],
      { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || r.stderr) w('boot', ['db-init', r.status, (r.stderr || '').trim()]);
  } catch (e) { w('boot', ['db-init failed', e.stack]); }
})();

// Windows helper programs (*.exe) -> Linux equivalents (scrcpy, phone drive, ...)
// Phone windows (mirroring, keyboard & mouse) open only when the user clicked for them (linux/user-intent.js).
let intent = null;
try { intent = require('./linux/user-intent.js'); intent.install(electron.app, m => w('exe', [m])); } catch (e) { w('exe', [e.stack]); }
try { require('./linux/exe-dispatch.js').install(m => w('exe', [m]), intent); } catch (e) { w('exe', [e.stack]); }

// Display-only English layer for strings that can't be changed in the code
try { require('./linux/dom-i18n.js').install(electron.app, m => w('i18n', [m])); } catch (e) { w('i18n', [e.stack]); }

// vivo cloud services -> Google equivalents; vivo-account sign-in hidden (PCSUITE_SHOW_CLOUD=1 keeps vivo's)
try { require('./linux/google-services.js').install(electron.app, m => w('google', [m])); } catch (e) { w('google', [e.stack]); }

// Phone drive: mount connected phones as folders (replaces vivo's vdfs/Dokan driver)
electron.app.whenReady().then(() => { try { require('./linux/phone-drive.js').start(m => w('drive', [m])); } catch (e) { w('drive', [e.stack]); } });

// iTunes-style main window with the music library and phone music sync (itunes/). PCSUITE_CLASSIC_UI=1 = vivo's own window.
if (!process.env.PCSUITE_CLASSIC_UI) { try { require('./itunes/main.js').install(electron, m => w('music', [m])); } catch (e) { w('music', [e.stack]); } }

require('./dist/electron/main.js');
w('boot', ['main.js loaded']);
