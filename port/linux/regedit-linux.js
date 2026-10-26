// Linux stand-in for the "regedit" npm module (Windows registry via cscript). vivo reads three keys;
// we answer them from the Linux environment so the callers get real values instead of errors.
'use strict';
const os = require('os'), path = require('path');
const sz = value => ({ type: 'REG_SZ', value });
function country() {
  if (process.env.PCSUITE_COUNTRY) return process.env.PCSUITE_COUNTRY.toUpperCase();
  try { return require('./dragfile-linux.js').getUserGeoName() || 'CN'; } catch (_) { return 'CN'; }
}
function lookup(key) {
  const k = key.toLowerCase();
  if (k.endsWith('\\pcsuite')) {
    return { exists: true, keys: [], values: { OsUserName: sz(os.userInfo().username), AppData: sz(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'))) } };
  }
  if (k.endsWith('\\international\\geo')) return { exists: true, keys: [], values: { Name: sz(country()), Nation: sz('') } };
  if (k.endsWith('\\control panel\\desktop')) return { exists: true, keys: [], values: { DragFullWindows: sz('1') } };
  return { exists: false, keys: [], values: {} };
}
function list(keys, arch, cb) {
  if (typeof arch === 'function') { cb = arch; arch = null; }
  const arr = Array.isArray(keys) ? keys : [keys];
  const res = {};
  for (const k of arr) res[k] = lookup(k);
  if (cb) setImmediate(() => cb(null, res));
  return res;
}
const ok = (...a) => { const cb = a.find(x => typeof x === 'function'); if (cb) setImmediate(() => cb(null)); };
module.exports = {
  list, createKey: ok, deleteKey: ok, putValue: ok, deleteValue: ok,
  setExternalVBSLocation: () => 'Folder found and set',
  arch: { list, createKey: ok, deleteKey: ok, putValue: ok },
  promisified: {
    list: (k, a) => new Promise(r => list(k, a, (e, v) => r(v))),
    createKey: () => Promise.resolve(), deleteKey: () => Promise.resolve(), putValue: () => Promise.resolve(), deleteValue: () => Promise.resolve(),
  },
};
