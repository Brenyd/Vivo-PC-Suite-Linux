// English completion pack for vivo PC Suite / Office Kit.
//  1. Adds translation keys that vivo's en_US locale is missing (they fall back to Chinese otherwise).
//  2. Replaces Chinese text hard-coded in UI templates/attributes with English.
// Only display positions are touched (see contexts.js); strings also used in comparisons are skipped.
// usage: node apply-english.js <pristine app dir> <output app dir>
'use strict';
const fs = require('fs'), path = require('path');
const [src, out] = process.argv.slice(2);
const dict = require('./en-dict.json');
const keep = new Set();   // filled below: strings the code also compares against (never translate those)
const CONTEXTS = require('./contexts.js');
const D = 'dist/electron';
const cjk = /[㐀-鿿]/;
const jsStr = s => JSON.stringify(s).slice(1, -1);                 // content of a "..." literal
const sqStr = s => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");  // content of a '...' literal

// ---------- 1. locale keys
function localeModules(txt) {
  const map = JSON.parse(txt.match(/var [a-z]=(\{"\.\/[^}]+\})/)[1]);
  const mods = {};
  for (const [name, id] of Object.entries(map)) {
    const re = new RegExp(`([,{]${id}:function\\(e\\)\\{e\\.exports=JSON\\.parse\\()('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")(\\)\\})`);
    const m = txt.match(re);
    if (m) mods[name] = { re, obj: JSON.parse(new Function('return ' + m[2])()) };
  }
  return mods;
}
const enFile = path.join(src, D, 'locales-en_US.js');
let enTxt = fs.readFileSync(enFile, 'utf8');
const en = localeModules(enTxt), zh = localeModules(fs.readFileSync(path.join(src, D, 'locales-zh_CN.js'), 'utf8'));
let added = 0, untranslated = [];
for (const [name, z] of Object.entries(zh)) {
  if (!en[name]) continue;
  let changed = false;
  for (const [k, v] of Object.entries(z.obj)) {
    if (k in en[name].obj) continue;
    if (dict[v] !== undefined) { en[name].obj[k] = dict[v]; added++; changed = true; }
    else untranslated.push(k);
  }
  if (changed) enTxt = enTxt.replace(en[name].re, (_, a, _lit, c) => `${a}'${sqStr(JSON.stringify(en[name].obj))}'${c}`);
}
fs.writeFileSync(path.join(out, D, 'locales-en_US.js'), enTxt);

// ---------- 1b. time-zone picker: English country/city names generated from the ISO country code and IANA zone id
{
  let names = null;
  try { names = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (_) {}
  const city = id => id.split('/').pop().replace(/_/g, ' ');
  for (const f of fs.readdirSync(path.join(out, D)).filter(f => f.endsWith('.js') && !/^locales|^vendors~formatjs/.test(f))) {
    const p = path.join(out, D, f); let s = fs.readFileSync(p, 'utf8'), n = 0;
    s = s.replace(/\{country:"([^"]*)",countryCode:"([A-Z]{2})",cityTimeZone:"([^"]*)",timeZoneID:"([^"]+)"/g, (w, c, cc, ct, id) => {
      let country = c; try { country = (names && names.of(cc)) || c; } catch (_) {}
      n++; return `{country:${JSON.stringify(country)},countryCode:"${cc}",cityTimeZone:${JSON.stringify(city(id))},timeZoneID:"${id}"`;
    });
    if (n) { fs.writeFileSync(p, s); console.log(`time zones: ${n} entries in English (${f})`); }
  }
}

// ---------- 1c. precise manifest (generated with a JS parser from this PC Suite version): exact literal -> English
{
  let manifest = {};
  try { manifest = require('./en-manifest.json'); } catch (_) {}
  let n = 0, files = 0;
  for (const [f, pairs] of Object.entries(manifest)) {
    const p = path.join(out, D, f);
    if (!fs.existsSync(p)) continue;
    let s = fs.readFileSync(p, 'utf8'), k = 0;
    for (const [from, to] of pairs) { if (s.includes(from)) { s = s.split(from).join(to); k++; } }
    if (k) { fs.writeFileSync(p, s); n += k; files++; }
  }
  console.log(`English pack: ${n} parser-verified strings translated in ${files} files`);
}

// ---------- 2. hard-coded strings
let replaced = 0;
const files = fs.readdirSync(path.join(out, D)).filter(f => f.endsWith('.js') && !/^locales|^vendors~formatjs/.test(f));
{ // safety: skip any string that also appears in a comparison / switch / includes() anywhere
  const all = files.map(f => fs.readFileSync(path.join(out, D, f), 'utf8')).join('\n');
  const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const z of Object.keys(dict)) {
    for (const lit of [`"${jsStr(z)}"`, `'${sqStr(z)}'`]) {
      if (!all.includes(lit)) continue;
      const L = reEsc(lit);
      if (new RegExp(`(?:[=!]==?|case)\\s*${L}|${L}\\s*[=!]==?|includes\\(${L}|indexOf\\(${L}|\\[${L}\\]`).test(all)) keep.add(z);
    }
  }
}
for (const f of files) {
  const p = path.join(out, D, f);           // work on the already-patched output file
  let s = fs.readFileSync(p, 'utf8'), n = 0;
  for (const re of CONTEXTS) {
    s = s.replace(re, (whole, ...args) => {
      const g = args[args.length - 1];
      if (!g || g.s === undefined || !cjk.test(g.s)) return whole;
      let raw;
      try { raw = new Function('return "' + g.s + '"')(); } catch (_) { return whole; }
      const t = raw.trim();
      if (keep.has(t) || dict[t] === undefined) return whole;
      const lead = raw.slice(0, raw.indexOf(t)), trail = raw.slice(raw.indexOf(t) + t.length);
      n++;
      return whole.replace(`"${g.s}"`, `"${jsStr(lead + dict[t] + trail)}"`);
    });
  }
  // single-quoted template text: _v('...')
  s = s.replace(/_v\('((?:[^'\\]|\\.)*)'\)/g, (whole, lit) => {
    if (!cjk.test(lit)) return whole;
    let raw; try { raw = new Function("return '" + lit + "'")(); } catch (_) { return whole; }
    const t = raw.trim(); if (keep.has(t) || dict[t] === undefined) return whole;
    n++; return `_v('${sqStr(raw.replace(t, dict[t])).replace(/\n/g, '\\n')}')`;
  });
  // display properties assigned in component code: this.placeholder="..."
  s = s.replace(/(this\.(?:placeholder|title|tipText|text|message|content|desc|label|tips?|btnText|subTitle)\s*=\s*)"((?:[^"\\]|\\.)*)"/g, (whole, pre, lit) => {
    if (!cjk.test(lit)) return whole;
    let raw; try { raw = new Function('return "' + lit + '"')(); } catch (_) { return whole; }
    const t = raw.trim(); if (keep.has(t) || dict[t] === undefined) return whole;
    n++; return `${pre}"${jsStr(raw.replace(t, dict[t]))}"`;
  });
  // text inside inline SVG illustrations
  s = s.replace(/>([^<>"]*[\u3400-\u9fff][^<>"]*)<\/(text|tspan)>/g, (whole, t, tag) => (dict[t.trim()] && !keep.has(t.trim())) ? (n++, `>${dict[t.trim()]}</${tag}>`) : whole);
  if (n) { fs.writeFileSync(p, s); replaced += n; }
}
console.log(`English pack: +${added} locale keys` + (untranslated.length ? ` (${untranslated.length} without translation)` : '') +
            `, ${replaced} hard-coded strings translated`);
