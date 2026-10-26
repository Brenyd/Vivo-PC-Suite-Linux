// Extracts strings needing English translation from vivo's bundles.
// usage: node extract.js <app dir> <out dir>
const fs = require('fs'), path = require('path');
const [app, out] = process.argv.slice(2);
const dir = path.join(app, 'dist/electron');
const cjk = /[㐀-鿿]/;

// ---- 1. locale keys missing from en_US
function loadLocale(file) {
  const s = fs.readFileSync(path.join(dir, file), 'utf8');
  const map = JSON.parse(s.match(/var [a-z]=(\{"\.\/[^}]+\})/)[1]);   // {"./album.json": id}
  const res = {};
  for (const [name, id] of Object.entries(map)) {
    const m = s.match(new RegExp(`[,{]${id}:function\\(e\\)\\{e\\.exports=JSON\\.parse\\(('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")\\)\\}`));
    res[name] = m ? JSON.parse(new Function('return ' + m[1])()) : {};
  }
  return res;
}
const en = loadLocale('locales-en_US.js'), zh = loadLocale('locales-zh_CN.js');
const missing = {};
for (const [name, obj] of Object.entries(zh)) for (const [k, v] of Object.entries(obj))
  if (!en[name] || !(k in en[name])) (missing[name] ??= {})[k] = v;
fs.writeFileSync(path.join(out, 'missing-locale-keys.zh.json'), JSON.stringify(missing, null, 1));

// ---- 2. hard-coded Chinese display strings
const CONTEXTS = require('./contexts.js');
const found = new Map();
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js') && !/^locales|^vendors~formatjs/.test(f))) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  for (const re of CONTEXTS) for (const m of s.matchAll(re)) {
    const raw = new Function('return "' + m.groups.s + '"')();   // unescape
    const t = raw.trim();
    if (cjk.test(t)) found.set(t, (found.get(t) || 0) + 1);
  }
}
fs.writeFileSync(path.join(out, 'hardcoded.zh.json'), JSON.stringify([...found.keys()].sort(), null, 1));
console.log('missing locale keys:', Object.values(missing).reduce((a, o) => a + Object.keys(o).length, 0), 'hardcoded strings:', found.size);
