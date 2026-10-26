// Applies the Linux port patches to vivo's (pristine) app folder.
// usage: node apply.js <pristine app dir> <output app dir>
// Patch entry: [file | '*', find (string|RegExp), replace, note, expectedCount?]
const fs = require('fs'), path = require('path');
const [src, out] = process.argv.slice(2);
const patches = require('./patches.js');
const jsDir = 'dist/electron';
const allJs = fs.readdirSync(path.join(src, jsDir)).filter(f => f.endsWith('.js')).map(f => `${jsDir}/${f}`);
const files = {};
const load = f => (files[f] ??= fs.readFileSync(path.join(src, f), 'utf8'));
let failed = 0;
for (const [file, find, repl, note, count] of patches) {
  const targets = file === '*' ? allJs : [file];
  let n = 0;
  for (const f of targets) {
    const txt = load(f);
    if (find instanceof RegExp) {
      const re = new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g');
      const m = txt.match(re); if (!m) continue;
      n += m.length; files[f] = txt.replace(re, repl);
    } else {
      const k = txt.split(find).length - 1; if (!k) continue;
      n += k; files[f] = txt.split(find).join(repl);
    }
  }
  if (n === 0 || (count && n !== count)) { console.error(`FAIL (${n}x) ${file}: ${note}`); failed++; }
  else if (process.env.VERBOSE) console.log(`ok (${n}x) ${note}`);
}
let written = 0;
for (const [f, txt] of Object.entries(files)) {
  const dst = path.join(out, f);
  if (!fs.existsSync(dst) || fs.readFileSync(dst, 'utf8') !== txt) { fs.writeFileSync(dst, txt); written++; }
}
console.log(`${patches.length - failed}/${patches.length} patches applied (${written} files updated)`);
process.exit(failed ? 1 : 0);
