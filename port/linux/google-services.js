// Replaces vivo's cloud services with Google ones, and hides everything that needs a vivo account sign-in.
//
//   vivo cloud                       -> Google
//   Contacts                         -> Google Contacts
//   Events (cloud calendar)          -> Google Calendar
//   To-dos                           -> Google Tasks
//   Notes cloud sync                 -> Google Keep
//   Cloud Drive                      -> Google Drive
//   Albums cloud backup              -> Google Photos
//   Find device                      -> Google Find My Device
//   vivo account avatar / "Sign in to auto-connect" / Browser sync / spam blocking / "sign in and turn on sync" -> hidden
//   (no Google web equivalent for browser sync or spam blocking)
//
// Google pages open inside the music window (one persistent Google sign-in, see itunes/main.js) or, with
// PCSUITE_CLASSIC_UI=1, in your web browser. PCSUITE_SHOW_CLOUD=1 leaves vivo's cloud UI untouched.
// vivo's markup has no stable class names, so elements are found by their (English or Chinese) text.
'use strict';

const SERVICES = {
  contacts: { name: 'Google Contacts', url: 'https://contacts.google.com/', desc: 'Your contacts, synced with your Google account' },
  calendar: { name: 'Google Calendar', url: 'https://calendar.google.com/', desc: 'Events and reminders' },
  tasks: { name: 'Google Tasks', url: 'https://tasks.google.com/', desc: 'To-dos and lists' },
  keep: { name: 'Google Keep', url: 'https://keep.google.com/', desc: 'Notes and checklists in the cloud' },
  drive: { name: 'Google Drive', url: 'https://drive.google.com/', desc: 'Files in the cloud' },
  photos: { name: 'Google Photos', url: 'https://photos.google.com/', desc: 'Photo backup and albums' },
  find: { name: 'Find My Device', url: 'https://www.google.com/android/find', desc: 'Locate, ring or lock your phone' },
};
const MARK = '__vk_google__';

// generic glyphs (not Google's logos), one color each
const ICONS = {
  contacts: ['#1a73e8', '<circle cx="12" cy="9" r="3.6"/><path d="M5 19c1.2-3.4 4-5 7-5s5.8 1.6 7 5"/>'],
  calendar: ['#1e8e3e', '<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'],
  tasks: ['#2b6cb0', '<circle cx="12" cy="12" r="8"/><path d="M8.5 12.2l2.4 2.4 4.6-4.8"/>'],
  keep: ['#e0a800', '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z"/>'],
  drive: ['#188038', '<path d="M8.5 4h7l5 8.5-3.5 6h-10L3.5 12.5z"/><path d="M8.5 4l5 8.5h7M3.5 12.5h10l-3.5 6"/>'],
  photos: ['#d93025', '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 3.5 3 3-2.5 4.5 4"/>'],
  find: ['#5f6368', '<path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'],
};
const icon = (k, size = 28) => `<span style="display:inline-flex;align-items:center;justify-content:center;width:${size + 16}px;height:${size + 16}px;border-radius:12px;background:${ICONS[k][0]}"><svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[k][1]}</svg></span>`;

const script = `(() => {
  if (window.__vkGoogle) return; window.__vkGoogle = true;
  const S = ${JSON.stringify(Object.fromEntries(Object.entries(SERVICES).map(([k, v]) => [k, { name: v.name, desc: v.desc }])))};
  const ICON = ${JSON.stringify(Object.fromEntries(Object.keys(ICONS).map(k => [k, icon(k)])))};
  const ICON_S = ${JSON.stringify(Object.fromEntries(Object.keys(ICONS).map(k => [k, icon(k, 18)])))};
  const open = k => console.debug(${JSON.stringify(MARK)} + k);
  // card title -> what replaces it ('' = hide only)
  const CARDS = [
    [/^(More cloud services|Cloud services|更多云服务|云服务)$/i, 'grid'],
    [/^(Events|日程)$/i, 'calendar'],
    [/^(To-?dos|待办)$/i, 'tasks'],
    [/^(Cloud Drive|云盘)$/i, 'drive'],
    [/^(Find device|Find my phone|查找设备)$/i, 'find'],
  ];
  // single cloud items (tiles/menu entries) -> Google service, '' = hide
  const ITEMS = [
    [/^(Contacts|联系人)$/i, 'contacts'], [/^(Cloud Drive|云盘)$/i, 'drive'], [/^(Find device|查找设备)$/i, 'find'],
    [/^(Browser|浏览器)$/i, ''], [/^(Spam blocking|骚扰拦截)$/i, ''], [/^(Cloud (space|storage|services?)|云空间|云服务)$/i, ''],
  ];
  const LOGIN_TEXT = /^(Sign in|Log in|Login|Sign in to .*|Log in to .*|登录.*|立即登录|账号登录)$/i;
  const SYNC_TEXT = /(sign in and turn on sync|sign in to (view|sync|use)|turn on (cloud )?sync|log in to (view|sync)|登录并开启同步|登录后|开启云同步)/i;
  const KEEP = /(Device connectivity|No network\\. Use USB|USB connection|设备互联|USB连接)/i;
  const W = () => document.documentElement.clientWidth || innerWidth;
  const mark = (el, why) => el.setAttribute('data-vk-hidden', why);
  const hide = el => { if (el && el !== document.body && !el.hasAttribute('data-vk-hidden')) { el.style.setProperty('display', 'none', 'important'); mark(el, 'cloud'); } return el; };
  const own = el => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue; return s.trim(); };
  function card(el) {
    let best = null;
    for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (r.width > W() * 0.62 || r.height > innerHeight * 0.75) break;
      if (KEEP.test(e.innerText || '')) break;
      best = e;
    }
    return best;
  }
  function small(el, maxH, maxW = 0.5) {
    let best = el;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (r.height > maxH || r.width > W() * maxW || KEEP.test(e.innerText || '')) break;
      best = e;
    }
    return best;
  }
  function tile(k) {
    const a = document.createElement('div');
    a.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;width:84px;text-align:center;font-size:12px;line-height:1.25;color:inherit';
    a.innerHTML = ICON[k] + '<span>' + S[k].name.replace(/^Google /, '') + '</span>';
    a.title = S[k].name; a.onclick = e => { e.stopPropagation(); open(k); };
    return a;
  }
  // a new card in the hidden card's place, with the same box styling
  function replace(old, titleEl, kind) {
    const cs = getComputedStyle(old), tcs = titleEl ? getComputedStyle(titleEl) : null;
    const box = document.createElement('div');
    mark(box, 'google');
    for (const p of ['background-color', 'border-radius', 'padding', 'margin', 'flex', 'grid-column', 'grid-row', 'width', 'min-width', 'max-width', 'box-shadow', 'border', 'box-sizing', 'color', 'font-family'])
      box.style.setProperty(p, cs.getPropertyValue(p));
    box.style.height = 'auto'; box.style.minHeight = Math.min(old.getBoundingClientRect().height || 170, 260) + 'px';
    const h = document.createElement('div');
    h.textContent = kind === 'grid' ? 'Google services' : S[kind].name;
    h.style.cssText = tcs ? 'font-size:' + tcs.fontSize + ';font-weight:' + tcs.fontWeight + ';margin-bottom:14px' : 'font-size:18px;font-weight:600;margin-bottom:14px';
    box.appendChild(h);
    if (kind === 'grid') {
      const g = document.createElement('div'); g.style.cssText = 'display:flex;flex-wrap:wrap;gap:14px 6px';
      for (const k of ['contacts', 'calendar', 'tasks', 'keep', 'drive', 'photos', 'find']) g.appendChild(tile(k));
      box.appendChild(g);
    } else {
      const r = document.createElement('div'); r.style.cssText = 'display:flex;align-items:center;gap:14px;cursor:pointer';
      r.innerHTML = ICON[kind] + '<div><div style="font-weight:600">Open ' + S[kind].name + '</div><div style="opacity:.6;font-size:12px;margin-top:3px">' + S[kind].desc + '</div></div>';
      r.onclick = () => open(kind);
      box.appendChild(r);
    }
    old.insertAdjacentElement('afterend', box);
  }
  function pass() {
    const all = document.body ? document.body.querySelectorAll('*:not([data-vk-hidden])') : [];
    for (const el of all) {
      if (!el.isConnected || el.closest('[data-vk-hidden],textarea,[contenteditable="true"],.tox,.ProseMirror')) continue;
      const t = own(el); if (!t || t.length > 120) continue;
      const c = CARDS.find(([re]) => re.test(t));
      if (c) {
        const box = card(el);
        // "Events"/"To-dos" only as the home-page cloud cards (which ask you to sign in), never inside Calendar itself
        if (box && (c[1] === 'grid' || c[1] === 'drive' || c[1] === 'find' || /sign in|log in|sync|登录|同步/i.test(box.innerText || ''))) { hide(box); replace(box, el, c[1]); }
        continue;
      }
      const it = ITEMS.find(([re]) => re.test(t));
      if (it) {
        const b = small(el, 110, 0.25);
        const r = b.getBoundingClientRect();
        // only tiles in cloud-service panels, never the left navigation (vivo's own USB features live there)
        if (r.width && r.width < 200 && r.left > 240) {
          if (!it[1]) { hide(b); continue; }
          b.style.setProperty('display', 'none', 'important'); mark(b, 'cloud');
          const tl = tile(it[1]); mark(tl, 'google'); b.insertAdjacentElement('afterend', tl);
        }
        continue;
      }
      if (LOGIN_TEXT.test(t) || /Sign in to auto-connect|登录自动连接/i.test(t)) {
        const b = el.closest('button,[role=button],a') || el;
        const r = b.getBoundingClientRect();
        // the vivo account block at the top of the sidebar (avatar + "Sign in to vivo…")
        if (r.left < 220 && r.top < 200) hide(small(b, 140)); else hide(b);
      } else if (SYNC_TEXT.test(t)) {
        const m = small(el, 90); hide(m);
        // e.g. the Notes card: offer the Google equivalent instead
        const ctx = (m.parentElement && m.parentElement.innerText || '') + ' ' + t;
        const k = /note|便签|笔记/i.test(ctx) ? 'keep' : /album|photo|相册/i.test(ctx) ? 'photos' : /calendar|event|日历|日程/i.test(ctx) ? 'calendar' : /to-?do|待办/i.test(ctx) ? 'tasks' : '';
        if (k && m.parentElement) {
          const a = document.createElement('div'); mark(a, 'google');
          a.style.cssText = 'display:flex;align-items:center;gap:10px;cursor:pointer;justify-content:center;padding:14px;font-size:13px';
          a.innerHTML = ICON_S[k] + '<span>Open ' + S[k].name + '</span>';
          a.onclick = () => open(k);
          m.insertAdjacentElement('afterend', a);
        }
      }
    }
  }
  // a timer, not requestAnimationFrame: the docked Office Kit window is often hidden, and rAF never fires there
  let q = 0; const run = () => { if (q) return; q = setTimeout(() => { q = 0; try { pass(); } catch (_) {} }, 150); };
  const start = () => {
    run(); new MutationObserver(run).observe(document.body, { subtree: true, childList: true, characterData: true });
    addEventListener('resize', run); document.addEventListener('visibilitychange', run);
  };
  document.body ? start() : document.addEventListener('DOMContentLoaded', start);
})();`;

let opener = null;   // set by the music window; otherwise pages open in the web browser
module.exports = {
  SERVICES, ICONS,
  setOpener(f) { opener = f; },
  install(app, log = () => {}) {
    if (process.env.PCSUITE_SHOW_CLOUD) return;
    app.on('web-contents-created', (_e, wc) => {
      wc.on('dom-ready', () => {
        if (/^vkmedia:|^https?:/.test(wc.getURL())) return;      // our music window and the Google pages themselves
        wc.executeJavaScript(script, true).catch(e => log('google: ' + e.message));
      });
      wc.on('console-message', (_ev, _l, msg) => {
        if (typeof msg !== 'string' || !msg.startsWith(MARK)) return;
        const k = msg.slice(MARK.length), s = SERVICES[k]; if (!s) return;
        log('google: open ' + k);
        if (opener) opener(k); else require('electron').shell.openExternal(s.url);
      });
    });
  },
  script,
};
