// Display-only English layer, injected into every app window.
// Translates leftover Chinese UI text right in the DOM (text nodes, placeholder/title attributes),
// so strings vivo's code also uses as keys/comparisons stay untouched in the code.
// User content (editors, inputs) is skipped.
'use strict';
const fs = require('fs'), path = require('path');
function buildScript() {
  const dir = path.join(__dirname, '..', 'i18n-data');
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; } };
  const dict = Object.assign({}, read('en-dict.json') || {}, read('dom-extra.json') || {});
  const subs = read('dom-substrings.json') || [];
  const rules = read('dom-rules.json') || [];
  return `(() => {
  if (window.__linuxI18n) return; window.__linuxI18n = true;
  const D = ${JSON.stringify(dict)}, SUBS = ${JSON.stringify(subs)}, RULES = ${JSON.stringify(rules)};
  const CJK = /[\\u3400-\\u9fff]/, LATIN = /[A-Za-z]/;
  const SKIP = 'textarea,input,[contenteditable=""],[contenteditable="true"],.ProseMirror,.tox,.note-content,.vnote-editor,pre,code,script,style';
  const skip = el => !el || (el.closest && el.closest(SKIP));
  const tr = (v, el) => {
    if (!v || !CJK.test(v)) return null;
    const t = v.trim();
    if (el && el.closest) for (const [sel, map] of RULES) if (map[t] !== undefined && el.closest(sel)) return v.replace(t, map[t]);
    const r = D[t];
    if (r !== undefined) return v.replace(t, r);
    if (LATIN.test(v)) { let s = v; for (const [a, b] of SUBS) if (s.includes(a)) s = s.split(a).join(b); return s !== v ? s : null; }
    return null;
  };
  const doText = n => { if (skip(n.parentElement)) return; const r = tr(n.nodeValue, n.parentElement); if (r !== null && r !== n.nodeValue) n.nodeValue = r; };
  const doAttrs = el => { if (skip(el)) return; for (const a of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute && el.getAttribute(a); const r = tr(v, el); if (r !== null) el.setAttribute(a, r); } };
  const walk = root => {
    if (root.nodeType === 3) return doText(root);
    if (root.nodeType !== 1) return;
    doAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? doText(n) : doAttrs(n);
  };
  const start = () => {
    walk(document.body);
    new MutationObserver(ms => { for (const m of ms) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else m.addedNodes.forEach(walk);
    } }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'] });
    const t = document.title; const r = tr(t); if (r) document.title = r;
  };
  document.body ? start() : document.addEventListener('DOMContentLoaded', start);
})();`;
}
let script = null;
module.exports = {
  install(app, log = () => {}) {
    if (process.env.PCSUITE_NO_DOM_I18N) return;
    app.on('web-contents-created', (_e, wc) => {
      wc.on('dom-ready', () => {
        try { script = script || buildScript(); wc.executeJavaScript(script, true).catch(() => {}); }
        catch (e) { log('dom-i18n: ' + e.message); }
      });
    });
  },
};
