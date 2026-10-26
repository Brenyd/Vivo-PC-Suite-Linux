// Linux replacement for vivo's phonecall/phoneCall.exe ("call handoff": calls ringing on the phone
// show up on the PC). vivo starts it with
//   --callinfo=<base64 JSON> --address --port --xpos --ypos --width --height --mode(0 light/1 dark) --token --device
// We show a small always-on-top call card and control the call over adb:
//   Answer  -> KEYCODE_HEADSETHOOK     Decline / Hang up -> KEYCODE_ENDCALL     Mute -> KEYCODE_MUTE
// "Listen on PC" plays the call audio through the PC speakers with scrcpy (voice-call audio source, Android 11+).
// The call card closes by itself when the phone's call state returns to idle.
'use strict';
const cp = require('child_process'), path = require('path');

const ADB = () => process.env.PCSUITE_ADB || 'adb';
let log = () => {};
let current = null;

function arg(args, k) {
  const a = args.find(x => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3).replace(/^"|"$/g, '') : '';
}
function serial() {
  try {
    const out = cp.execFileSync(ADB(), ['devices'], { encoding: 'utf8', timeout: 5000 });
    const r = out.split('\n').slice(1).map(l => l.trim().split(/\s+/)).filter(p => p[1] === 'device').map(p => p[0]);
    return r.find(s => !s.includes(':')) || r[0] || null;
  } catch (_) { return null; }
}
const adbShell = (s, cmd) => new Promise(res => cp.execFile(ADB(), ['-s', s, 'shell', cmd], { timeout: 6000 }, (e, out) => res(e ? '' : String(out))));
async function callState(s) {
  // 0 idle, 1 ringing, 2 off-hook (in call)
  const out = await adbShell(s, 'dumpsys telephony.registry | grep -m3 mCallState');
  const v = out.match(/mCallState=(\d)/g);
  if (!v) return -1;
  return Math.max(...v.map(x => Number(x.slice(-1))));
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(info, dark) {
  const name = info.name || info.callerName || info.number || 'Unknown number';
  const sub = [info.name ? info.number : '', info.location || info.city || ''].filter(Boolean).join(' · ');
  const sim = info.simIndex != null || info.sim != null ? `SIM ${Number(info.simIndex != null ? info.simIndex : info.sim) + (Number(info.simIndex) === 0 ? 1 : 0)}` : '';
  const bg = dark ? '#262626' : '#ffffff', fg = dark ? '#f2f2f2' : '#1a1a1a', mut = dark ? '#a0a0a0' : '#666';
  return `<!doctype html><meta charset="utf-8"><title>Incoming call</title><style>
  html,body{margin:0;height:100%;background:transparent;font:14px system-ui,sans-serif;color:${fg};-webkit-user-select:none;overflow:hidden}
  .card{box-sizing:border-box;height:100%;background:${bg};border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;-webkit-app-region:drag;border:1px solid ${dark ? '#3a3a3a' : '#e3e3e3'}}
  .top{display:flex;justify-content:space-between;color:${mut};font-size:12px}
  .name{font-size:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .sub{color:${mut};font-size:12px;min-height:15px}
  .row{display:flex;gap:10px;margin-top:auto;-webkit-app-region:no-drag}
  a{flex:1;text-align:center;text-decoration:none;color:#fff;border-radius:18px;padding:8px 0;font-weight:600;cursor:pointer}
  .ans{background:#32BF55}.end{background:#ED4D47}.opt{background:${dark ? '#3a3a3a' : '#eee'};color:${fg};flex:.8}
  .opt.on{background:#456fff;color:#fff}
  .x{flex:none;color:${mut};text-decoration:none;-webkit-app-region:no-drag;padding:0 2px}
  </style><div class="card">
  <div class="top"><span id="st">Incoming call${sim ? ' · ' + esc(sim) : ''}</span><a class="x" href="vivocall://close" title="Hide">✕</a></div>
  <div class="name">${esc(name)}</div><div class="sub">${esc(sub)}</div>
  <div class="row" id="ring"><a class="end" href="vivocall://end">Decline</a><a class="ans" href="vivocall://answer">Answer</a></div>
  <div class="row" id="talk" style="display:none"><a class="opt" id="mute" href="vivocall://mute">Mute</a><a class="opt" id="pc" href="vivocall://pcaudio">Listen on PC</a><a class="end" href="vivocall://end">Hang up</a></div>
  </div><script>
  let t0=0,iv=0;function state(s){const st=document.getElementById('st');
   if(s===2){document.getElementById('ring').style.display='none';document.getElementById('talk').style.display='flex';
    if(!t0){t0=Date.now();iv=setInterval(()=>{const d=Math.floor((Date.now()-t0)/1000);st.textContent='In call · '+String(Math.floor(d/60)).padStart(2,'0')+':'+String(d%60).padStart(2,'0')},1000)}}}
  function toggle(id,on){document.getElementById(id).classList.toggle('on',on)}
  </script>`;
}

function open(args) {
  const { BrowserWindow, screen } = require('electron');
  let info = {};
  try { info = JSON.parse(Buffer.from(arg(args, 'callinfo'), 'base64').toString('utf8')); } catch (_) {}
  if (info && typeof info.data === 'string') { try { Object.assign(info, JSON.parse(info.data)); } catch (_) {} }
  if (info && info.callInfo && typeof info.callInfo === 'object') Object.assign(info, info.callInfo);
  log('phone-call: ' + JSON.stringify(Object.assign({}, info, { number: info.number ? '…' + String(info.number).slice(-4) : undefined })));
  if (current) { try { current.win.close(); } catch (_) {} }

  const s = serial();
  const W = 340, H = 150;
  const wa = (screen.getPrimaryDisplay() || {}).workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const win = new BrowserWindow({
    width: W, height: H, x: wa.x + wa.width - W - 16, y: wa.y + wa.height - H - 16,
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: false, show: false,
    title: 'vivo call', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page(info, arg(args, 'mode') === '1')));
  win.once('ready-to-show', () => win.showInactive ? win.show() : win.show());

  // placeholder process so vivo's process tracking works; killing it closes the card and vice versa
  const proc = cp.spawn('sleep', ['infinity'], { stdio: 'ignore' });
  const st = { win, proc, muted: false, audio: null, seen: 0, poll: null };
  current = st;
  const close = () => {
    clearInterval(st.poll);
    if (st.audio) { try { st.audio.kill(); } catch (_) {} st.audio = null; }
    if (!win.isDestroyed()) win.destroy();
    try { proc.kill(); } catch (_) {}
    if (current === st) current = null;
  };
  proc.on('exit', close);
  win.on('closed', close);

  const key = k => s && adbShell(s, `input keyevent ${k}`);
  win.webContents.on('will-navigate', (e, url) => {
    e.preventDefault();
    const act = url.replace('vivocall://', '').replace(/\/$/, '');
    log('phone-call: ' + act);
    if (act === 'answer') key('KEYCODE_HEADSETHOOK');
    else if (act === 'end') { key('KEYCODE_ENDCALL'); setTimeout(close, 800); }
    else if (act === 'close') close();
    else if (act === 'mute') { st.muted = !st.muted; key('KEYCODE_MUTE'); win.webContents.executeJavaScript(`toggle('mute',${st.muted})`).catch(() => {}); }
    else if (act === 'pcaudio') {
      if (st.audio) { st.audio.kill(); st.audio = null; }
      else if (s) {
        st.audio = cp.spawn('scrcpy', ['-s', s, '--no-video', '--no-window', '--no-control', '--audio-source=voice-call'], { stdio: 'ignore' });
        st.audio.on('error', () => { st.audio = null; log('phone-call: scrcpy not available for call audio'); });
        st.audio.on('exit', () => { st.audio = null; if (!win.isDestroyed()) win.webContents.executeJavaScript(`toggle('pc',false)`).catch(() => {}); });
      }
      win.webContents.executeJavaScript(`toggle('pc',${!!st.audio})`).catch(() => {});
    }
  });

  // follow the phone's call state; close when the call is over
  const started = Date.now();
  if (s) st.poll = setInterval(async () => {
    const c = await callState(s);
    if (win.isDestroyed()) return;
    if (c > 0) { st.seen = Math.max(st.seen, c); win.webContents.executeJavaScript(`state(${c})`).catch(() => {}); }
    else if (c === 0 && (st.seen || Date.now() - started > 8000)) close();
  }, 1000);
  else setTimeout(close, 60000);
  return proc;
}

module.exports = { open, setLogger(l) { log = l || log; } };
