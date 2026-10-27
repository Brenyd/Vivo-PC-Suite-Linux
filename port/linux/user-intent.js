// Tracks what the user actually clicked, so phone windows (screen mirroring, keyboard & mouse) only open
// when the user asked for them. vivo starts its relay/mirroring helpers by itself at launch and restarts them
// whenever they exit; on Windows those are invisible background services, but on Linux each one became a
// scrcpy window that reopened every time it was closed.
//
// A tiny script in every app window reports clicks (the text of the clicked control) to the main process
// through the console, so no preload or IPC changes to vivo's windows are needed.
'use strict';

const MARK = '__vk_click__';
const KINDS = {
  // order matters: "keyboard & mouse" items may also mention the screen
  keymouse: /keyboard|mouse|键鼠|键盘|鼠标|跨屏|cross.?device control/i,
  drive: /explorer|open (in )?(the )?folder|phone drive|this pc|资源管理器|此电脑|打开文件夹|在文件夹中/i,
  mirror: /mirror|screen|projection|cast|投屏|镜像|屏幕|多屏|pc ?mode/i,
};
const last = { any: 0, keymouse: 0, mirror: 0, drive: 0 };
const listeners = new Set();
let log = () => {};

const script = `(() => {
  if (window.__vkIntent) return; window.__vkIntent = true;
  const label = t => { for (let el = t, i = 0; el && i < 6; el = el.parentElement, i++) {
    const s = ((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || el.innerText || '').trim();
    if (s && s.length <= 60) return s; } return ''; };
  addEventListener('pointerdown', e => { try { console.debug(${JSON.stringify(MARK)} + JSON.stringify({ t: label(e.target) })); } catch (_) {} }, true);
  addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') try { console.debug(${JSON.stringify(MARK)} + JSON.stringify({ t: label(e.target) })); } catch (_) {} }, true);
})();`;

const classify = text => { for (const [k, re] of Object.entries(KINDS)) if (re.test(text)) return k; return null; };
function record(text) {
  const now = Date.now();
  last.any = now;
  const k = classify(text); if (k) last[k] = now;
  log(`intent: click "${String(text).slice(0, 40)}"`);
  for (const f of listeners) { try { f(text); } catch (_) {} }
}

module.exports = {
  install(app, logger) {
    log = logger || log;
    app.on('web-contents-created', (_e, wc) => {
      wc.on('dom-ready', () => wc.executeJavaScript(script, true).catch(() => {}));
      wc.on('console-message', (_ev, _lvl, msg) => {
        if (typeof msg !== 'string' || !msg.startsWith(MARK)) return;
        if (/^vkmedia:/.test(wc.getURL())) return;       // the music window opens these itself
        try { record(JSON.parse(msg.slice(MARK.length)).t || ''); } catch (_) {}
      });
    });
  },
  /** Explicit request from our own UI (sidebar button etc). */
  request(kind) { last[kind] = last.any = Date.now(); },
  /** True (once) if the user asked for `kind` within `ms`. Generic clicks count for mirroring only. */
  consume(kind, ms = 60000) {
    const now = Date.now();
    const ok = now - last[kind] < ms || (kind === 'mirror' && now - last.any < 4000);
    if (ok) { last[kind] = 0; if (kind === 'mirror') last.any = 0; }
    return ok;
  },
  classify,
  onClick(f) { listeners.add(f); return () => listeners.delete(f); },
  _record: record,
};
