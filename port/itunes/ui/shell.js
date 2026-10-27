// vivo Office Kit for Linux: iTunes-style music library, player, phone sync, Office Kit and Google panes.
'use strict';
/* global vk, I */

// ================================================================ helpers
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'html') e.innerHTML = v; else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = s => { s = Math.max(0, Math.round(s || 0)); const hh = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = String(s % 60).padStart(2, '0'); return hh ? `${hh}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`; };
const fmtTotal = s => s >= 86400 ? `${(s / 86400).toFixed(1)} days` : s >= 3600 ? `${(s / 3600).toFixed(1)} hours` : `${Math.round(s / 60)} minutes`;
const fmtBytes = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round((n || 0) / 1e3)} KB`;
const fmtDate = t => t ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const sortName = s => String(s || '').replace(/^(the|a|an)\s+/i, '');
const artUrl = t => t && t.art ? `vkmedia://app/~art/${t.art}${t.artRev ? '?' + t.artRev : ''}` : '';
const albumArtist = t => t.compilation ? 'Compilations' : (t.albumArtist || t.artist || 'Unknown Artist');
const albumId = t => (t.compilation ? 'Compilations' : (t.albumArtist || t.artist)) + '\u0001' + (t.album || '');
const uid = () => Math.random().toString(36).slice(2, 10);
function toast(msg, ms = 3200) { const t = h('div', { class: 'toast' }, msg); document.body.append(t); setTimeout(() => t.remove(), ms); }

// ================================================================ state
const S = {
  tracks: new Map(), playlists: [], settings: {}, services: {}, ffmpeg: true, folders: [],
  route: 'albums', back: [], fwd: [], sel: new Set(), anchor: null, search: '',
  sort: { key: 'artist', dir: 1 }, devices: [], adbMissing: false, sync: null, scan: null, google: {},
  artist: null, devEdit: {}, phoneList: {}, d: null,
};
// derived indexes (rebuilt when tracks change)
function derive() {
  const albums = new Map(), artists = new Map(), genres = new Map();
  for (const t of S.tracks.values()) {
    const id = albumId(t);
    let a = albums.get(id);
    if (!a) albums.set(id, a = { id, name: t.album || 'Unknown Album', artist: albumArtist(t), year: 0, genre: '', art: '', artRev: 0, tracks: [], added: 0 });
    a.tracks.push(t); a.year = a.year || t.year; a.genre = a.genre || t.genre; if (!a.art && t.art) { a.art = t.art; a.artRev = t.artRev; }
    a.added = Math.max(a.added, t.added || 0);
    const an = albumArtist(t);
    if (!artists.has(an)) artists.set(an, { name: an, albums: new Set(), count: 0, art: '' });
    const ar = artists.get(an); ar.albums.add(id); ar.count++; if (!ar.art && t.art) ar.art = t.art;
    const g = t.genre || 'Unknown Genre';
    if (!genres.has(g)) genres.set(g, { name: g, albums: new Set(), count: 0 });
    genres.get(g).albums.add(id); genres.get(g).count++;
  }
  for (const a of albums.values()) a.tracks.sort((x, y) => (x.disc || 0) - (y.disc || 0) || (x.track || 0) - (y.track || 0) || coll.compare(x.title, y.title));
  S.d = { albums, artists, genres };
}
const all = () => [...S.tracks.values()];

// ================================================================ smart playlists
const FIELDS = {
  title: ['Name', 'text'], artist: ['Artist', 'text'], albumArtist: ['Album Artist', 'text'], album: ['Album', 'text'], genre: ['Genre', 'text'],
  composer: ['Composer', 'text'], kind: ['Kind', 'text'], year: ['Year', 'num'], rating: ['Rating (stars)', 'num'], plays: ['Plays', 'num'],
  skips: ['Skips', 'num'], duration: ['Time (minutes)', 'num'], added: ['Date Added', 'date'], lastPlayed: ['Last Played', 'date'], loved: ['Loved', 'bool'],
};
const OPS = {
  text: [['contains', 'contains'], ['notContains', 'does not contain'], ['is', 'is'], ['isNot', 'is not'], ['startsWith', 'starts with'], ['endsWith', 'ends with']],
  num: [['is', 'is'], ['isNot', 'is not'], ['gt', 'is greater than'], ['lt', 'is less than']],
  date: [['inLast', 'is in the last (days)'], ['notInLast', 'is not in the last (days)']],
  bool: [['true', 'is true'], ['false', 'is false']],
};
function ruleMatch(t, c) {
  const type = (FIELDS[c.f] || [])[1];
  let v = t[c.f];
  if (type === 'text') {
    v = String(v || '').toLowerCase(); const x = String(c.v || '').toLowerCase();
    return { contains: v.includes(x), notContains: !v.includes(x), is: v === x, isNot: v !== x, startsWith: v.startsWith(x), endsWith: v.endsWith(x) }[c.op];
  }
  if (type === 'num') {
    if (c.f === 'rating') v = Math.round((v || 0) / 20); else if (c.f === 'duration') v = (v || 0) / 60; else v = +v || 0;
    const x = +c.v || 0;
    return { is: Math.round(v) === x, isNot: Math.round(v) !== x, gt: v > x, lt: v < x }[c.op];
  }
  if (type === 'date') { const within = v && Date.now() - v < (+c.v || 0) * 864e5; return c.op === 'inLast' ? !!within : !within; }
  if (type === 'bool') return c.op === 'true' ? !!v : !v;
  return true;
}
function playlistTracks(p) {
  if (!p) return [];
  if (p.smart) {
    const r = p.rules || { match: 'all', conds: [] };
    let out = all().filter(t => !r.conds.length || (r.match === 'any' ? r.conds.some(c => ruleMatch(t, c)) : r.conds.every(c => ruleMatch(t, c))));
    const by = r.limit && r.limit.on ? r.limit.by : r.sort;
    const sorters = { plays: (a, b) => (b.plays || 0) - (a.plays || 0), added: (a, b) => (b.added || 0) - (a.added || 0), lastPlayed: (a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0), rating: (a, b) => (b.rating || 0) - (a.rating || 0), random: () => Math.random() - .5, name: (a, b) => coll.compare(a.title, b.title) };
    if (by && sorters[by]) out.sort(sorters[by]); else out.sort(defaultSort);
    if (r.limit && r.limit.on) out = out.slice(0, Math.max(1, +r.limit.n || 25));
    return out;
  }
  return (p.items || []).map(id => S.tracks.get(id)).filter(Boolean);
}
const defaultSort = (a, b) => coll.compare(sortName(albumArtist(a)), sortName(albumArtist(b))) || coll.compare(a.album, b.album) || (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0);
function defaultPlaylists() {
  return [
    { id: uid(), name: "90's Music", smart: true, rules: { match: 'all', conds: [{ f: 'year', op: 'gt', v: 1989 }, { f: 'year', op: 'lt', v: 2000 }] } },
    { id: uid(), name: 'Recently Played', smart: true, rules: { match: 'all', conds: [{ f: 'lastPlayed', op: 'inLast', v: 14 }], sort: 'lastPlayed' } },
    { id: uid(), name: 'Top 25 Most Played', smart: true, rules: { match: 'all', conds: [{ f: 'plays', op: 'gt', v: 0 }], limit: { on: true, n: 25, by: 'plays' } } },
    { id: uid(), name: 'My Top Rated', smart: true, rules: { match: 'all', conds: [{ f: 'rating', op: 'gt', v: 3 }], sort: 'rating' } },
    { id: uid(), name: 'Loved', smart: true, rules: { match: 'all', conds: [{ f: 'loved', op: 'true' }] } },
  ];
}
function savePlaylists() { vk.libSetPlaylists(S.playlists); renderSide(); }
function resolvedPlaylists() { return Object.fromEntries(S.playlists.map(p => [p.id, playlistTracks(p).map(t => t.id)])); }

// ================================================================ player
const audio = $('#audio');
const P = { ids: [], order: [], pos: -1, upNext: [], cur: null, label: '', shuffle: false, repeat: 'off', playing: false };
let actx = null, eqNodes = [], pre = null;
const EQ_FREQ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], Acoustic: [5, 5, 4, 1, 2, 2, 3.5, 4, 3.5, 2], 'Bass Booster': [5.5, 4.5, 3.5, 2.5, 1.5, 0, 0, 0, 0, 0],
  'Bass Reducer': [-5.5, -4.5, -3.5, -2.5, -1.5, 0, 0, 0, 0, 0], Classical: [5, 4, 3.5, 3, -1.5, -1.5, 0, 2.5, 3.5, 4], Dance: [3.5, 6.5, 5, 0, 2, 3.5, 5, 4.5, 3.5, 0],
  Deep: [5, 3.5, 1.5, 1, 3, 2.5, 1.5, -2, -3.5, -4.5], Electronic: [4.5, 4, 1.5, 0, -2, 2, 1, 1.5, 4, 5], 'Hip-Hop': [5, 4.5, 1.5, 3, -1, -1, 1.5, -.5, 2, 3],
  Jazz: [4, 3, 1.5, 2, -1.5, -1.5, 0, 1.5, 3, 3.5], Latin: [4.5, 3, 0, 0, -1.5, -1.5, -1.5, 0, 3, 4.5], Loudness: [6, 4, 0, 0, -2, 0, -1, -5, 5, 1],
  Lounge: [-3, -1.5, -.5, 1.5, 4, 2.5, 0, -1.5, 2, 1], Piano: [3, 2, 0, 2.5, 3, 1.5, 3.5, 4.5, 3, 3.5], Pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
  'R&B': [2.5, 7, 5.5, 1.5, -2.5, -1.5, 2.5, 3, 3, 4], Rock: [5, 4, 3, 1.5, -.5, -1, .5, 2.5, 3.5, 4.5], 'Small Speakers': [5.5, 4, 3.5, 2.5, 1.5, 0, -1.5, -3, -3.5, -4.5],
  'Spoken Word': [-3.5, -.5, 0, .5, 3.5, 4.5, 5, 4, 2.5, 0], 'Treble Booster': [0, 0, 0, 0, 0, 1.5, 2.5, 3.5, 4.5, 5.5], 'Treble Reducer': [0, 0, 0, 0, 0, -1.5, -2.5, -3.5, -4.5, -5.5],
  'Vocal Booster': [-1.5, -3, -3, 1.5, 4, 4, 3, 1.5, 0, -1.5],
};
function eqSettings() { return Object.assign({ on: false, preset: 'Flat', pre: 0, bands: EQ_PRESETS.Flat.slice() }, S.settings.eq || {}); }
function ensureGraph() {
  if (actx) return;
  try {
    actx = new AudioContext();
    const src = actx.createMediaElementSource(audio);
    pre = actx.createGain();
    eqNodes = EQ_FREQ.map((f, i) => { const b = actx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === 9 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1.2; return b; });
    let n = src.connect(pre); for (const b of eqNodes) n = n.connect(b); n.connect(actx.destination);
    applyEq();
  } catch (e) { console.warn('audio graph', e); actx = null; }
}
function applyEq() {
  if (!actx) return;
  const e = eqSettings();
  pre.gain.value = e.on ? Math.pow(10, (+e.pre || 0) / 20) : 1;
  eqNodes.forEach((b, i) => { b.gain.value = e.on ? (+e.bands[i] || 0) : 0; });
}
function buildOrder(start) {
  const n = P.ids.length, idx = [...Array(n).keys()];
  if (P.shuffle) { for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } if (start >= 0) { idx.splice(idx.indexOf(start), 1); idx.unshift(start); } }
  P.order = idx; P.pos = start >= 0 ? idx.indexOf(start) : 0;
}
function playList(ids, start = 0, label = '', shuffle) {
  if (!ids.length) return;
  if (shuffle != null) { P.shuffle = shuffle; saveSettingsSoon(); }
  P.ids = ids.slice(); P.label = label;
  buildOrder(shuffle && start === 0 ? -1 : start);
  if (P.shuffle && shuffle && start === 0) P.pos = 0;
  load(P.ids[P.order[P.pos]], true);
  renderTop();
}
let skipT = 0;
function load(id, autoplay) {
  const t = S.tracks.get(id); if (!t) return;
  if (P.cur && P.cur !== id && audio.currentTime > 2 && audio.currentTime < 20 && !audio.ended) vk.libSkipped(P.cur);
  P.cur = id;
  audio.src = 'vkmedia://app/~track/' + id;
  if (autoplay) { ensureGraph(); if (actx && actx.state === 'suspended') actx.resume(); audio.play().catch(e => toast('Can\'t play this song: ' + e.message)); }
  mediaSession(t);
  renderLcd(); markNow();
}
function next(auto) {
  if (P.repeat === 'one' && auto && P.cur) { audio.currentTime = 0; audio.play(); return; }
  if (P.upNext.length) { const id = P.upNext.shift(); renderUpNext(); return load(id, true); }
  if (!P.order.length) return stop();
  if (P.pos + 1 >= P.order.length) {
    if (P.repeat === 'all') { buildOrder(-1); P.pos = 0; return load(P.ids[P.order[0]], true); }
    return stop();
  }
  P.pos++; load(P.ids[P.order[P.pos]], true);
}
function prev() {
  if (audio.currentTime > 3 || P.pos <= 0) { audio.currentTime = 0; return; }
  P.pos--; load(P.ids[P.order[P.pos]], true);
}
function stop() { audio.pause(); audio.removeAttribute('src'); audio.load(); P.cur = null; P.pos = -1; renderLcd(); renderTop(); markNow(); }
function togglePlay() {
  if (!P.cur) { const ids = currentListIds(); const start = ids.indexOf([...S.sel][0]); if (ids.length) playList(ids, Math.max(0, start), routeTitle()); return; }
  ensureGraph(); if (actx && actx.state === 'suspended') actx.resume();
  audio.paused ? audio.play() : audio.pause();
}
function playNext(ids) { P.upNext.unshift(...ids); if (!P.cur) next(); renderUpNext(); toast(ids.length > 1 ? `${ids.length} songs will play next` : 'Will play next'); }
function addUpNext(ids) { P.upNext.push(...ids); if (!P.cur) next(); renderUpNext(); toast(`Added ${plural(ids.length, 'song')} to Up Next`); }
audio.addEventListener('ended', () => { if (P.cur) vk.libPlayed(P.cur); next(true); });
audio.addEventListener('play', () => { P.playing = true; renderTop(); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'playing'; });
audio.addEventListener('pause', () => { P.playing = false; renderTop(); if (navigator.mediaSession) navigator.mediaSession.playbackState = 'paused'; });
audio.addEventListener('timeupdate', () => lcdProgress());
audio.addEventListener('error', () => { if (P.cur) { toast('Couldn\'t play "' + (S.tracks.get(P.cur) || {}).title + '" — the file may have moved'); setTimeout(() => next(true), 800); } });
function mediaSession(t) {
  if (!navigator.mediaSession) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title, artist: t.artist, album: t.album, artwork: t.art ? [{ src: artUrl(t), sizes: '600x600', type: 'image/jpeg' }] : [] });
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => audio.play()); ms.setActionHandler('pause', () => audio.pause());
    ms.setActionHandler('previoustrack', prev); ms.setActionHandler('nexttrack', () => next());
    ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; });
  } catch (_) {}
}
let saveT = 0;
function saveSettingsSoon() { clearTimeout(saveT); saveT = setTimeout(() => vk.libSetSettings({ volume: audio.volume, shuffle: P.shuffle, repeat: P.repeat }), 600); }

// ================================================================ top bar + LCD
function renderTop() {
  $('#playBtn').innerHTML = (P.playing ? I.pause : I.play)(26);
  $('#playBtn').title = P.playing ? 'Pause (Space)' : 'Play (Space)';
  $('#shuffleBtn').innerHTML = I.shuffle(17); $('#shuffleBtn').classList.toggle('on', P.shuffle);
  $('#repeatBtn').innerHTML = (P.repeat === 'one' ? I.repeat1 : I.repeat)(17); $('#repeatBtn').classList.toggle('on', P.repeat !== 'off');
  $('#repeatBtn').title = { off: 'Repeat: off', all: 'Repeat: all', one: 'Repeat: one' }[P.repeat];
  $('#volIcon').innerHTML = (audio.volume ? I.vol : I.vol0)(15);
  $('#vol').style.setProperty('--p', audio.volume * 100 + '%');
}
let lcdMode = '';
function renderLcd() {
  const l = $('#lcd'), sy = S.sync;
  if (sy && !sy.hide) {
    lcdMode = 'sync';
    const frac = sy.total ? (sy.bytes || 0) / sy.total : sy.n ? (sy.i || 0) / sy.n : sy.done ? 1 : 0;
    l.innerHTML = `<div class="logo" style="flex:none;width:42px;border-right:1px solid var(--lcd-border)">${sy.done ? (sy.error ? I.info(20) : I.sync(20)) : '<div class="spin"></div>'}</div>
      <div class="mid"><div class="t1">${esc(sy.done ? (sy.error ? sy.label + ': ' + sy.error : sy.label) : `Syncing “${sy.name || 'phone'}”${sy.step ? ` (Step ${sy.step} of ${sy.steps})` : ''}`)}</div>
      <div class="t2">${esc(sy.done ? (sy.copied != null ? `${plural(sy.copied, 'item')} copied${sy.removed ? `, ${sy.removed} removed` : ''}` : '') : (sy.label || '') + (sy.title ? ': ' + sy.title : ''))}</div>
      <div class="prog"><i style="width:${(frac * 100).toFixed(1)}%"></i></div></div>`;
    const x = h('button', { class: 'ibtn x', title: sy.done ? 'Dismiss' : 'Cancel sync', html: I.close(14), onclick: () => { if (sy.done) { S.sync = null; renderLcd(); } else vk.devCancel(); } });
    l.append(x);
    return;
  }
  const t = P.cur && S.tracks.get(P.cur);
  if (!t) { lcdMode = 'idle'; l.innerHTML = `<div class="logo">${I.logo(26)}</div>`; return; }
  lcdMode = 'play';
  l.innerHTML = `<div class="art" style="background-image:${t.art ? `url('${artUrl(t)}')` : 'none'}"></div><div class="mid">
    <span class="tm l" id="tmL"></span><span class="tm r" id="tmR"></span>
    <div class="t1">${esc(t.title)}</div><div class="t2">${esc([t.artist, t.album].filter(Boolean).join(' — '))}</div>
    <div class="prog" id="prog"><i id="progI"></i></div></div>`;
  $('#prog').addEventListener('mousedown', e => {
    const seek = ev => { const r = $('#prog').getBoundingClientRect(); const f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)); if (audio.duration) audio.currentTime = f * audio.duration; lcdProgress(); };
    seek(e); const up = () => { removeEventListener('mousemove', seek); removeEventListener('mouseup', up); };
    addEventListener('mousemove', seek); addEventListener('mouseup', up);
  });
  l.querySelector('.art').onclick = () => { const a = S.d.albums.get(albumId(t)); if (a) go('album:' + a.id); };
  lcdProgress();
}
function lcdProgress() {
  if (lcdMode !== 'play') return;
  const d = audio.duration || (S.tracks.get(P.cur) || {}).duration || 0, c = audio.currentTime || 0;
  const i = $('#progI'); if (i) i.style.width = (d ? c / d * 100 : 0) + '%';
  const L = $('#tmL'), R = $('#tmR'); if (L) L.textContent = fmtTime(c); if (R) R.textContent = '-' + fmtTime(d - c);
}

// ================================================================ routing
const GROUPS = { library: ['recent', 'artists', 'albums', 'songs', 'genres', 'album', 'genre', 'playlist', 'search'], phone: ['device'], office: ['office'], google: ['google'] };
const groupOf = r => Object.keys(GROUPS).find(g => GROUPS[g].includes(r.split(':')[0])) || 'library';
function go(route, { replace, noHistory } = {}) {
  if (route === S.route) return render();
  if (!noHistory && !replace) { S.back.push(S.route); S.fwd = []; }
  S.route = route; S.sel.clear(); S.anchor = null;
  if (!route.startsWith('search')) { S.search = ''; $('#search').value = ''; }
  render();
}
function render() {
  renderSide(); renderSub();
  const r = S.route, [kind, ...rest] = r.split(':'), arg = rest.join(':');
  const pane = kind === 'office' ? 'office' : kind === 'google' ? 'google:' + arg : 'music';
  vk.appPane(pane, mainRect());
  if (kind === 'office') vk.appOffice(arg || 'home');
  const v = $('#view'); v.innerHTML = ''; v.scrollTop = 0; v.onscroll = null; v.style.overflow = ''; $('#status').textContent = '';
  document.querySelectorAll('#devbar').forEach(x => x.remove()); TBL = null;
  const fn = { recent: viewRecent, artists: viewArtists, albums: viewAlbums, songs: viewSongs, genres: viewGenres, album: viewAlbum, genre: viewGenre,
    playlist: viewPlaylist, search: viewSearch, device: viewDevice, office: viewOffice, google: viewGoogle }[kind] || viewAlbums;
  try { fn(v, arg); } catch (e) { console.error(e); v.append(h('div', { class: 'empty' }, 'Something went wrong: ' + e.message)); }
}
function mainRect() { const r = $('#main').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }
new ResizeObserver(() => vk.appRect(mainRect())).observe($('#main'));
function routeTitle() {
  const [k, ...rest] = S.route.split(':'), a = rest.join(':');
  if (k === 'playlist') return (S.playlists.find(p => p.id === a) || {}).name || 'Playlist';
  if (k === 'album') return (S.d.albums.get(a) || {}).name || 'Album';
  return { recent: 'Recently Added', artists: 'Artists', albums: 'Albums', songs: 'Songs', genres: 'Genres', genre: a, search: 'Search' }[k] || 'Music';
}

// ================================================================ sub bar (nav, picker, tabs)
function connectedDevice() { return S.devices.find(d => d.state === 'device') || null; }
function renderSub() {
  $('#backBtn').disabled = !S.back.length; $('#fwdBtn').disabled = !S.fwd.length;
  const g = groupOf(S.route);
  const names = { library: ['note', 'Music'], phone: ['phone', 'Phone'], office: ['home', 'Office Kit'], google: ['g_drive', 'Google'] };
  $('#picker').innerHTML = `${I[names[g][0]](14)}<span>${names[g][1]}</span>${I.down(11)}`;
  const d = connectedDevice(), chip = $('#devchip');
  chip.hidden = !d; if (d) { chip.innerHTML = I.phone(15) + `<span style="font-size:12px">${esc(d.name || d.model || 'Phone')}</span>`; chip.classList.toggle('active', g === 'phone'); chip.title = d.name || ''; }
  const tabs = $('#tabs'); tabs.innerHTML = '';
  for (const [k, label] of [['library', 'Library'], ['phone', 'Phone'], ['office', 'Office Kit'], ['google', 'Google']])
    tabs.append(h('button', { class: g === k ? 'on' : '', disabled: k === 'phone' && !d, onclick: () => goGroup(k) }, label));
}
function goGroup(k) {
  const d = connectedDevice();
  if (k === 'library') go(S.lastLib || 'albums');
  else if (k === 'phone') d ? go(`device:${d.serial}:summary`) : go('office:connect');
  else if (k === 'office') go('office:home');
  else if (k === 'google') go('google:' + (S.lastGoogle || 'calendar'));
}

// ================================================================ sidebar
function sideItem(icon, label, route, opts = {}) {
  const sel = S.route === route || (opts.match && opts.match(S.route));
  const el = h('div', { class: `it${opts.ind ? ' ind' : ''}${sel ? ' sel' : ''}${opts.dim ? ' dim' : ''}`, title: opts.title || label },
    h('span', { html: I[icon](15), style: { flex: 'none', display: 'inline-flex' } }), h('span', {}, label), opts.badge != null ? h('span', { class: 'badge' }, opts.badge) : null);
  el.onclick = opts.onclick || (() => go(route));
  if (opts.oncontextmenu) el.oncontextmenu = opts.oncontextmenu;
  return el;
}
function renderSide() {
  const s = $('#side'); const sc = s.scrollTop; s.innerHTML = '';
  const lib = (icon, label, r) => sideItem(icon, label, r, { match: x => r === 'albums' && x.startsWith('album:') || r === 'genres' && x.startsWith('genre:') });
  s.append(h('h4', {}, 'Library'), lib('clock', 'Recently Added', 'recent'), lib('artist', 'Artists', 'artists'), lib('album', 'Albums', 'albums'), lib('note', 'Songs', 'songs'), lib('genre', 'Genres', 'genres'));

  const d = connectedDevice();
  s.append(h('h4', {}, 'Devices'));
  if (S.adbMissing) s.append(sideItem('info', 'adb is not installed', '', { dim: true, onclick: () => toast('Install it with: sudo pacman -S android-tools android-udev') }));
  const others = S.devices.filter(x => x.state !== 'device');
  for (const x of others) s.append(sideItem('phone', x.state === 'unauthorized' ? 'Phone: allow USB debugging' : `Phone (${x.state})`, '', { dim: true, onclick: () => toast('Unlock the phone and tap “Allow” on the USB debugging prompt') }));
  if (d) {
    const base = `device:${d.serial}`;
    s.append(sideItem('phone', d.name || d.model || 'Phone', base + ':summary', { badge: d.battery != null ? d.battery + '%' : null }));
    s.append(sideItem('info', 'Summary', base + ':summary', { ind: true }), sideItem('note', 'Music', base + ':music', { ind: true }),
      sideItem('list', 'On My Phone', base + ':onphone', { ind: true }),
      sideItem('photos', 'Photos', 'office:albums', { ind: true }), sideItem('notes', 'Notes', 'office:notes', { ind: true }),
      sideItem('calendar', 'Calendar', 'office:calendar', { ind: true }), sideItem('recorder', 'Recorder', 'office:recorder', { ind: true }),
      sideItem('folder', 'Files', '', { ind: true, onclick: () => vk.appLaunch('drive').then(ok => ok || toast('The phone drive (~/vivo Phone) isn\'t mounted yet')) }),
      sideItem('mirror', 'Screen Mirroring', '', { ind: true, onclick: () => vk.appLaunch('mirror').then(ok => ok || toast('Screen mirroring needs scrcpy and a phone connected with USB debugging')) }),
      sideItem('keyboard', 'Keyboard & Mouse', '', { ind: true, onclick: () => vk.appLaunch('keymouse').then(ok => ok || toast('Keyboard & mouse needs scrcpy and a phone connected with USB debugging')) }));
  } else if (!others.length && !S.adbMissing) s.append(sideItem('connect', 'Connect a phone…', 'office:connect', { dim: true }));

  s.append(h('h4', {}, 'Office Kit'), sideItem('home', 'Home', 'office:home'), sideItem('connect', 'Connect', 'office:connect'),
    ...(d ? [] : [sideItem('notes', 'Notes', 'office:notes'), sideItem('calendar', 'Calendar', 'office:calendar'), sideItem('photos', 'Albums', 'office:albums'), sideItem('recorder', 'Recorder', 'office:recorder')]),
    sideItem('tools', 'Tools', 'office:tools'), sideItem('settings', 'Settings', 'office:settings'));

  s.append(h('h4', {}, 'Google'));
  for (const k of ['contacts', 'calendar', 'tasks', 'keep', 'drive', 'photos', 'find']) if (S.services[k]) s.append(sideItem('g_' + k, S.services[k].name.replace(/^Google /, ''), 'google:' + k, { title: S.services[k].name }));

  const add = h('button', { class: 'ibtn', title: 'New Playlist', html: I.plus(13), onclick: e => menu(e, [{ label: 'New Playlist', k: 'Ctrl+N', fn: () => newPlaylist() }, { label: 'New Smart Playlist…', fn: () => smartDialog() }]) });
  s.append(h('h4', {}, 'Music Playlists', add));
  for (const p of S.playlists) {
    const el = sideItem(p.smart ? 'smart' : 'playlist', p.name, 'playlist:' + p.id, { oncontextmenu: e => playlistMenu(e, p) });
    if (S.renaming === p.id) {
      const inp = h('input', { class: 'rename', value: p.name });
      el.children[1].replaceWith(inp);
      setTimeout(() => { inp.focus(); inp.select(); });
      const done = ok => { if (S.renaming !== p.id) return; S.renaming = null; if (ok && inp.value.trim()) p.name = inp.value.trim(); savePlaylists(); if (S.route === 'playlist:' + p.id) render(); };
      inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
      inp.onblur = () => done(true);
    }
    if (!p.smart) {
      el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-vk-tracks')) { e.preventDefault(); el.classList.add('drop'); } });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', e => { el.classList.remove('drop'); const ids = JSON.parse(e.dataTransfer.getData('application/x-vk-tracks') || '[]'); addToPlaylist(p, ids); });
    }
    s.append(el);
  }
  s.scrollTop = sc;
}
function newPlaylist(ids = []) {
  const p = { id: uid(), name: ids.length ? (S.tracks.get(ids[0]) || {}).album || 'Playlist' : 'Playlist', items: ids.slice() };
  let n = p.name, i = 2; while (S.playlists.some(x => x.name === n)) n = `${p.name} ${i++}`; p.name = n;
  S.playlists.push(p); S.renaming = p.id; savePlaylists(); go('playlist:' + p.id);
}
function addToPlaylist(p, ids) { p.items = (p.items || []).concat(ids); savePlaylists(); toast(`Added ${plural(ids.length, 'song')} to “${p.name}”`); if (S.route === 'playlist:' + p.id) render(); }
function playlistMenu(e, p) {
  menu(e, [
    { label: 'Play', fn: () => playList(playlistTracks(p).map(t => t.id), 0, p.name) }, { label: 'Shuffle', fn: () => playList(playlistTracks(p).map(t => t.id), 0, p.name, true) }, '-',
    { label: 'Rename', fn: () => { S.renaming = p.id; renderSide(); } }, p.smart ? { label: 'Edit Smart Playlist…', fn: () => smartDialog(p) } : null,
    { label: 'Duplicate', fn: () => { const c = JSON.parse(JSON.stringify(p)); c.id = uid(); c.name += ' copy'; S.playlists.push(c); savePlaylists(); } }, '-',
    { label: 'Delete Playlist', fn: () => { S.playlists = S.playlists.filter(x => x !== p); savePlaylists(); if (S.route === 'playlist:' + p.id) go('songs', { replace: true }); } },
  ]);
}

// ================================================================ menus
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.forEach(m => m.remove()); openMenu = null; } }
function menu(e, items, at) {
  e && e.preventDefault && e.preventDefault(); e && e.stopPropagation && e.stopPropagation();
  closeMenu(); openMenu = [];
  const x = at ? at.x : e.clientX, y = at ? at.y : e.clientY;
  build(items, x, y, 0);
  function build(items, x, y, level) {
    openMenu.splice(level);
    const m = h('div', { class: 'menu' });
    for (const it of items.filter(Boolean)) {
      if (it === '-') { m.append(h('hr')); continue; }
      if (it.header) { m.append(h('div', { class: 'hd' }, it.header)); continue; }
      const mi = h('div', { class: `mi${it.checked ? ' chk' : ''}${it.disabled ? ' dis' : ''}${it.sub ? ' sub' : ''}` }, h('span', {}, it.label), it.k ? h('span', { class: 'k' }, it.k) : null);
      mi.onmouseenter = () => { for (const o of openMenu.slice(level + 1)) o.remove(); openMenu.splice(level + 1); if (it.sub) { const r = mi.getBoundingClientRect(); build(typeof it.sub === 'function' ? it.sub() : it.sub, r.right - 4, r.top - 5, level + 1); } };
      if (!it.disabled && !it.sub) mi.onclick = ev => { ev.stopPropagation(); closeMenu(); it.fn && it.fn(); };
      m.append(mi);
    }
    document.body.append(m); openMenu[level] = m;
    const r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
  }
}
addEventListener('mousedown', e => { if (openMenu && !openMenu.some(m => m.contains(e.target))) closeMenu(); if (upPop && !upPop.contains(e.target) && !$('#upNextBtn').contains(e.target)) closeUpNext(); });
addEventListener('blur', closeMenu);
function appMenu(e) {
  const d = connectedDevice();
  const theme = S.settings.theme || 'system';
  menu(null, [
    { label: 'File', sub: [
      { label: 'New Playlist', k: 'Ctrl+N', fn: () => newPlaylist() }, { label: 'New Smart Playlist…', k: 'Ctrl+Alt+N', fn: () => smartDialog() }, '-',
      { label: 'Add File to Library…', k: 'Ctrl+O', fn: addFiles }, { label: 'Add Folder to Library…', fn: addFolder }, { label: 'Update Library', fn: () => vk.libScan() }, '-',
      { label: 'Close Window', k: 'Ctrl+W', fn: () => vk.appWin('close') }, { label: 'Quit', k: 'Ctrl+Q', fn: () => vk.appWin('quit') }] },
    { label: 'Edit', sub: [{ label: 'Select All', k: 'Ctrl+A', fn: selectAll }, { label: 'Get Info', k: 'Ctrl+I', fn: () => infoDialog([...S.sel]), disabled: !S.sel.size }, '-', { label: 'Preferences…', k: 'Ctrl+,', fn: prefsDialog }] },
    { label: 'View', sub: [{ label: 'Up Next', k: 'Ctrl+Alt+U', fn: toggleUpNext }, '-', { header: 'Appearance' },
      ...['system', 'light', 'dark'].map(t => ({ label: t[0].toUpperCase() + t.slice(1), checked: theme === t, fn: () => setTheme(t) }))] },
    { label: 'Controls', sub: [
      { label: P.playing ? 'Pause' : 'Play', k: 'Space', fn: togglePlay }, { label: 'Next', k: 'Ctrl+→', fn: () => next() }, { label: 'Previous', k: 'Ctrl+←', fn: prev }, '-',
      { label: 'Shuffle', checked: P.shuffle, fn: toggleShuffle }, { label: 'Repeat', sub: ['off', 'all', 'one'].map(r => ({ label: { off: 'Off', all: 'All', one: 'One' }[r], checked: P.repeat === r, fn: () => { P.repeat = r; renderTop(); saveSettingsSoon(); } })) }, '-',
      { label: 'Increase Volume', k: 'Ctrl+↑', fn: () => setVol(audio.volume + .1) }, { label: 'Decrease Volume', k: 'Ctrl+↓', fn: () => setVol(audio.volume - .1) }, '-',
      { label: 'Equalizer…', k: 'Ctrl+Shift+E', fn: eqDialog }] },
    { label: 'Phone', sub: [
      { label: d ? `Sync “${d.name}”` : 'Sync', disabled: !d || !!(S.sync && !S.sync.done), fn: () => startSync(d.serial) },
      { label: 'Screen Mirroring', disabled: !d, fn: () => vk.appLaunch('mirror') }, { label: 'Keyboard & Mouse', disabled: !d, fn: () => vk.appLaunch('keymouse') },
      { label: 'Open Phone Drive', disabled: !d, fn: () => vk.appLaunch('drive') }] },
    { label: 'Help', sub: [{ label: 'Open Logs Folder', fn: () => vk.appLogs() }, { label: 'Project Page', fn: () => vk.appExternal('https://github.com/Brenyd/Vivo-PC-Suite-Linux') }, { label: 'Developer Tools', fn: () => vk.appWin('devtools') }] },
  ], { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 2 });
}
function setTheme(t) { S.settings.theme = t; document.documentElement.dataset.theme = t === 'system' ? '' : t; if (t === 'system') delete document.documentElement.dataset.theme; vk.libSetSettings({ theme: t }); }
function setVol(v) { audio.volume = Math.max(0, Math.min(1, v)); $('#vol').value = audio.volume; renderTop(); saveSettingsSoon(); }
function toggleShuffle() { P.shuffle = !P.shuffle; if (P.ids.length && P.pos >= 0) buildOrder(P.order[P.pos]); renderTop(); saveSettingsSoon(); }
function selectAll() { const ids = currentListIds(); S.sel = new Set(ids); refreshSel(); }
async function addFiles() { const r = await vk.libAddFiles(); if (r) toast(`Added ${plural(r.added, 'song')}`); }
async function addFolder() { const r = await vk.libAddFolder(); if (r) toast('Folder added to the library'); }

// ================================================================ Up Next popover
let upPop = null;
function closeUpNext() { if (upPop) { upPop.remove(); upPop = null; } }
function toggleUpNext() { if (upPop) return closeUpNext(); upPop = h('div', { class: 'pop' }); document.body.append(upPop); renderUpNext(); }
function renderUpNext() {
  if (!upPop) return;
  const b = $('#upNextBtn').getBoundingClientRect();
  upPop.style.top = b.bottom + 6 + 'px'; upPop.style.left = Math.min(b.left - 150, innerWidth - 350) + 'px';
  const rest = P.order.slice(P.pos + 1, P.pos + 60).map(i => P.ids[i]);
  const row = (id, cls) => { const t = S.tracks.get(id); if (!t) return null; return h('div', { class: 'q ' + (cls || ''), ondblclick: () => { load(id, true); } }, h('div', { class: 'c', style: { backgroundImage: t.art ? `url('${artUrl(t)}')` : '' } }), h('div', { class: 'tx' }, h('div', {}, t.title), h('div', {}, t.artist || ''))); };
  upPop.innerHTML = '';
  upPop.append(h('h4', {}, 'Up Next', h('button', { class: 'btn', onclick: () => { P.upNext = []; renderUpNext(); } }, 'Clear')));
  const items = h('div', { class: 'items' });
  if (P.cur) items.append(h('div', { class: 'hd', style: { padding: '6px 14px', fontSize: '11px', color: 'var(--fg3)' } }, 'Now Playing'), row(P.cur, 'cur'));
  if (P.upNext.length) { items.append(h('div', { style: { padding: '6px 14px', fontSize: '11px', color: 'var(--fg3)' } }, 'Up Next')); P.upNext.forEach(id => items.append(row(id))); }
  if (rest.length) { items.append(h('div', { style: { padding: '6px 14px', fontSize: '11px', color: 'var(--fg3)' } }, `From ${P.label || 'Library'}`)); rest.forEach(id => items.append(row(id))); }
  if (!P.cur && !P.upNext.length) items.append(h('div', { class: 'q', style: { color: 'var(--fg2)' } }, 'Nothing is queued. Right-click a song and choose Play Next or Add to Up Next.'));
  upPop.append(items);
}

// ================================================================ track table (virtualized)
const COLS = {
  now: { w: '24px', label: '', cls: 'now', get: t => P.cur === t.id ? I.speaker(13) : '', html: true },
  num: { w: '36px', label: '#', cls: 'num' },
  title: { w: 'minmax(160px,2fr)', label: 'Name', sort: (a, b) => coll.compare(a.title, b.title) },
  duration: { w: '58px', label: 'Time', cls: 'dur', get: t => fmtTime(t.duration), sort: (a, b) => (a.duration || 0) - (b.duration || 0) },
  artist: { w: 'minmax(110px,1.3fr)', label: 'Artist', sort: (a, b) => coll.compare(sortName(a.artist), sortName(b.artist)) || defaultSort(a, b) },
  album: { w: 'minmax(110px,1.3fr)', label: 'Album', sort: (a, b) => coll.compare(a.album, b.album) || (a.disc || 0) - (b.disc || 0) || (a.track || 0) - (b.track || 0) },
  genre: { w: 'minmax(70px,.7fr)', label: 'Genre', sort: (a, b) => coll.compare(a.genre, b.genre) || defaultSort(a, b) },
  loved: { w: '26px', label: '♥', cls: 'now', get: t => t.loved ? `<span class="heart">${I.heartf(12)}</span>` : '', html: true, sort: (a, b) => (b.loved ? 1 : 0) - (a.loved ? 1 : 0) },
  rating: { w: '70px', label: 'Rating', get: t => stars(t), html: true, sort: (a, b) => (b.rating || 0) - (a.rating || 0) },
  plays: { w: '50px', label: 'Plays', cls: 'plays', get: t => t.plays || '', sort: (a, b) => (b.plays || 0) - (a.plays || 0) },
  added: { w: '100px', label: 'Date Added', get: t => fmtDate(t.added), sort: (a, b) => (b.added || 0) - (a.added || 0) },
};
const stars = t => { const n = Math.round((t.rating || 0) / 20); return `<span class="stars" data-id="${t.id}">${[1, 2, 3, 4, 5].map(i => `<i data-r="${i}" class="${i <= n ? 'on' : ''}">★</i>`).join('')}</span>`; };
let TBL = null;   // current table state
function table(container, items, { cols = ['now', 'title', 'duration', 'artist', 'album', 'genre', 'loved', 'rating', 'plays'], ordered = null, sortable = true, keyOf = t => t.id, onOpen, onMenu, colDefs = COLS } = {}) {
  let list = items.slice();
  const sorted = () => { if (ordered && !S.sortOverride) return; const c = colDefs[S.sort.key]; if (c && c.sort) { list.sort(c.sort); if (S.sort.dir < 0) list.reverse(); } };
  if (sortable) sorted();
  const tpl = cols.map(c => colDefs[c].w).join(' ');
  const wrap = h('div', { class: 'table' });
  const head = h('div', { class: 'thead', style: { gridTemplateColumns: tpl } });
  for (const c of cols) {
    const cd = colDefs[c];
    const el = h('div', { class: sortable && S.sort.key === c && (!ordered || S.sortOverride) ? 'sorted' : '' }, cd.label, sortable && S.sort.key === c && (!ordered || S.sortOverride) ? h('span', { html: (S.sort.dir > 0 ? I.down : I.up)(10) }) : null);
    if (sortable && cd.sort) el.onclick = () => { if (S.sort.key === c) S.sort.dir *= -1; else S.sort = { key: c, dir: 1 }; if (ordered) S.sortOverride = true; render(); };
    if (c === 'num' && ordered) el.onclick = () => { S.sortOverride = false; render(); };
    head.append(el);
  }
  const body = h('div', { style: { position: 'relative', height: list.length * 24 + 'px' } });
  wrap.append(head, body); container.append(wrap);
  const view = $('#view');
  const draw = () => {
    const top = body.getBoundingClientRect().top - view.getBoundingClientRect().top + view.scrollTop;
    const from = Math.max(0, Math.floor((view.scrollTop - top) / 24) - 8), to = Math.min(list.length, Math.ceil((view.scrollTop - top + view.clientHeight) / 24) + 8);
    body.innerHTML = '';
    for (let i = from; i < to; i++) {
      const t = list[i], k = keyOf(t);
      const row = h('div', { class: `trow${S.sel.has(k) ? ' sel' : ''}`, style: { top: i * 24 + 'px', gridTemplateColumns: tpl, background: i % 2 ? 'var(--bg)' : 'var(--bg-alt)' }, draggable: 'true', 'data-k': k, 'data-i': i });
      for (const c of cols) {
        const cd = colDefs[c]; const v = c === 'num' ? i + 1 : cd.get ? cd.get(t) : t[c];
        const cell = h('div', { class: cd.cls || '' }); if (cd.html) cell.innerHTML = v; else cell.textContent = v == null ? '' : v; row.append(cell);
      }
      body.append(row);
    }
  };
  draw(); view.onscroll = draw;
  const rowOf = e => e.target.closest('.trow');
  body.addEventListener('mousedown', e => {
    const r = rowOf(e); if (!r) return;
    const st = e.target.closest('.stars i');
    if (st) { const id = st.parentElement.dataset.id; const t = S.tracks.get(id); const n = +st.dataset.r; const val = Math.round((t.rating || 0) / 20) === n ? 0 : n * 20; vk.libUpdate([id], { rating: val }); return; }
    const k = r.dataset.k, i = +r.dataset.i;
    if (e.shiftKey && S.anchor != null) { const a = list.findIndex(x => keyOf(x) === S.anchor); const [lo, hi] = [Math.min(a, i), Math.max(a, i)]; if (!e.ctrlKey) S.sel.clear(); for (let j = lo; j <= hi; j++) S.sel.add(keyOf(list[j])); }
    else if (e.ctrlKey || e.metaKey) { S.sel.has(k) ? S.sel.delete(k) : S.sel.add(k); S.anchor = k; }
    else if (!(S.sel.has(k) && e.button === 2) && !(S.sel.has(k) && S.sel.size > 1 && e.button === 0)) { S.sel = new Set([k]); S.anchor = k; }
    draw();
  });
  body.addEventListener('click', e => { const r = rowOf(e); if (!r || e.ctrlKey || e.shiftKey || e.target.closest('.stars')) return; if (S.sel.size > 1 && S.sel.has(r.dataset.k)) { S.sel = new Set([r.dataset.k]); S.anchor = r.dataset.k; draw(); } });
  body.addEventListener('dblclick', e => { const r = rowOf(e); if (!r || e.target.closest('.stars')) return; onOpen ? onOpen(list[+r.dataset.i], +r.dataset.i, list) : playList(list.map(keyOf), +r.dataset.i, routeTitle()); });
  body.addEventListener('contextmenu', e => { const r = rowOf(e); if (!r) return; if (!S.sel.has(r.dataset.k)) { S.sel = new Set([r.dataset.k]); draw(); } (onMenu || trackMenu)(e, [...S.sel], list); });
  // drag: to playlists in the sidebar, or reorder inside a playlist
  body.addEventListener('dragstart', e => {
    const r = rowOf(e); if (!r) return;
    if (!S.sel.has(r.dataset.k)) { S.sel = new Set([r.dataset.k]); draw(); }
    const ids = list.map(keyOf).filter(k => S.sel.has(k));
    e.dataTransfer.setData('application/x-vk-tracks', JSON.stringify(ids)); e.dataTransfer.effectAllowed = 'copyMove';
    const n = h('div', { style: { position: 'fixed', top: '-100px', padding: '4px 10px', background: 'var(--sel)', color: '#fff', borderRadius: '10px', fontSize: '12px' } }, plural(ids.length, 'song'));
    document.body.append(n); e.dataTransfer.setDragImage(n, 10, 10); setTimeout(() => n.remove());
  });
  if (ordered) {
    let over = null;
    body.addEventListener('dragover', e => { if (!e.dataTransfer.types.includes('application/x-vk-tracks') || S.sortOverride) return; e.preventDefault(); const r = rowOf(e); if (over && over !== r) over.classList.remove('dropline'); over = r; if (r) r.classList.add('dropline'); });
    body.addEventListener('drop', e => {
      e.preventDefault(); const ids = JSON.parse(e.dataTransfer.getData('application/x-vk-tracks') || '[]'); const r = rowOf(e);
      const at = r ? +r.dataset.i : list.length;
      const keep = ordered.items.filter((id, i) => !(ids.includes(id) && list[i] && S.sel.has(list[i].id)));
      const before = ordered.items.slice(0, at).filter(id => keep.includes(id)).length;
      const moving = ids;
      ordered.items = keep.slice(0, before).concat(moving, keep.slice(before));
      savePlaylists(); render();
    });
  }
  TBL = { list, keyOf, draw };
  return list;
}
function refreshSel() { if (TBL) TBL.draw(); else render(); }
function currentListIds() { if (TBL && $('#view').contains(document.querySelector('.table'))) return TBL.list.map(TBL.keyOf); return []; }
function markNow() { if (TBL && document.querySelector('.table')) TBL.draw(); document.querySelectorAll('.album .trk, .agroup .trk').forEach(r => r.classList.toggle('now', r.dataset.id === P.cur)); }
function statusFor(tracks) {
  const dur = tracks.reduce((a, t) => a + (t.duration || 0), 0), size = tracks.reduce((a, t) => a + (t.size || 0), 0);
  $('#status').textContent = tracks.length ? `${plural(tracks.length, 'song')}, ${fmtTotal(dur)}, ${fmtBytes(size)}` : '';
}
function trackMenu(e, ids, list) {
  const inPl = S.route.startsWith('playlist:') && S.playlists.find(p => p.id === S.route.slice(9));
  const t0 = S.tracks.get(ids[0]) || {};
  const allLoved = ids.every(id => (S.tracks.get(id) || {}).loved);
  menu(e, [
    { label: 'Play', fn: () => { const l = list.map(t => t.id); playList(l, Math.max(0, l.indexOf(ids[0])), routeTitle()); } },
    { label: 'Play Next', fn: () => playNext(ids) }, { label: 'Add to Up Next', fn: () => addUpNext(ids) }, '-',
    { label: 'Add to Playlist', sub: () => [{ label: 'New Playlist', fn: () => newPlaylist(ids) }, '-', ...S.playlists.filter(p => !p.smart).map(p => ({ label: p.name, fn: () => addToPlaylist(p, ids) }))] }, '-',
    { label: allLoved ? 'Unlove' : 'Love', fn: () => vk.libUpdate(ids, { loved: !allLoved }) },
    { label: 'Rating', sub: [0, 1, 2, 3, 4, 5].map(n => ({ label: n ? '★'.repeat(n) : 'None', checked: ids.length === 1 && Math.round((t0.rating || 0) / 20) === n, fn: () => vk.libUpdate(ids, { rating: n * 20 }) })) }, '-',
    { label: ids.length > 1 ? `Get Info (${ids.length} songs)` : 'Get Info', k: 'Ctrl+I', fn: () => infoDialog(ids) },
    { label: 'Show in Folder', disabled: ids.length !== 1, fn: () => vk.libShow(ids[0]) },
    { label: 'Show Album', fn: () => go('album:' + albumId(t0)) }, '-',
    inPl && !inPl.smart ? { label: 'Remove from Playlist', k: 'Del', fn: () => { const sel = new Set(ids); let removed = 0; inPl.items = inPl.items.filter(id => !(sel.has(id) && ++removed)); savePlaylists(); render(); } } : null,
    { label: 'Delete from Library…', fn: () => deleteTracks(ids) },
  ]);
}
function deleteTracks(ids) {
  dialog(ids.length > 1 ? `Delete ${ids.length} songs from your library?` : `Delete “${(S.tracks.get(ids[0]) || {}).title}” from your library?`,
    h('div', {}, h('p', { style: { margin: '0 0 8px', color: 'var(--fg2)' } }, 'Keep the files to only take them out of the library (they\'ll come back on the next library update if they\'re inside a library folder), or move them to the Trash.')),
    [{ label: 'Cancel' }, { label: 'Keep Files', fn: () => vk.libRemove(ids, false) }, { label: 'Move to Trash', primary: true, fn: () => vk.libRemove(ids, true) }]);
}

// ================================================================ views: library
function viewSongs(v) {
  S.lastLib = 'songs';
  const tr = all();
  if (!tr.length) return emptyLibrary(v);
  table(v, tr); statusFor(tr);
}
function emptyLibrary(v) {
  const scanning = S.scan && !S.scan.finished;
  v.append(h('div', { class: 'empty' }, h('div', { html: I.logo(64) }), h('h2', {}, scanning ? 'Updating your library…' : 'Your music library is empty'),
    h('div', {}, scanning ? `${S.scan.done} of ${S.scan.total} files` : S.folders.length ? `Nothing playable was found in ${S.folders.join(', ')}.` : 'Add a folder with your music. Files stay where they are.'),
    scanning ? null : h('div', { style: { display: 'flex', gap: '8px' } }, h('button', { class: 'btn primary', onclick: addFolder }, 'Add Folder…'), h('button', { class: 'btn', onclick: addFiles }, 'Add Files…')),
    h('div', { style: { fontSize: '12px' } }, 'You can also drag music files or folders onto this window.')));
}
function albumTiles(v, albums, { showArtist = true } = {}) {
  const g = h('div', { class: 'grid' });
  for (const a of albums) {
    const cover = h('div', { class: 'cover' + (a.art ? '' : ' none'), style: a.art ? { backgroundImage: `url('vkmedia://app/~art/${a.art}${a.artRev ? '?' + a.artRev : ''}')` } : {}, html: a.art ? '' : I.note(40) });
    const pl = h('div', { class: 'pl', html: I.play(15), title: 'Play' }); cover.append(pl);
    pl.onclick = e => { e.stopPropagation(); playList(a.tracks.map(t => t.id), 0, a.name); };
    const tile = h('div', { class: 'tile' }, cover, h('div', { class: 'n', title: a.name }, a.name), showArtist ? h('div', { class: 'a' }, a.artist) : h('div', { class: 'a' }, a.year || ''));
    tile.onclick = () => go('album:' + a.id);
    tile.oncontextmenu = e => trackMenu(e, a.tracks.map(t => t.id), a.tracks);
    tile.draggable = true; tile.ondragstart = e => e.dataTransfer.setData('application/x-vk-tracks', JSON.stringify(a.tracks.map(t => t.id)));
    g.append(tile);
  }
  v.append(g);
}
const albumsSorted = () => [...S.d.albums.values()].sort((a, b) => coll.compare(sortName(a.artist), sortName(b.artist)) || (a.year || 0) - (b.year || 0) || coll.compare(a.name, b.name));
function viewAlbums(v) {
  S.lastLib = 'albums';
  if (!S.tracks.size) return emptyLibrary(v);
  const al = albumsSorted(); albumTiles(v, al);
  $('#status').textContent = `${plural(al.length, 'album')}, ${plural(S.tracks.size, 'song')}`;
}
function viewRecent(v) {
  S.lastLib = 'recent';
  if (!S.tracks.size) return emptyLibrary(v);
  v.append(h('div', { class: 'head' }, h('h1', {}, 'Recently Added')));
  albumTiles(v, [...S.d.albums.values()].sort((a, b) => b.added - a.added).slice(0, 120));
}
function viewGenres(v) {
  S.lastLib = 'genres';
  if (!S.tracks.size) return emptyLibrary(v);
  const g = h('div', { class: 'grid' });
  for (const gn of [...S.d.genres.values()].sort((a, b) => coll.compare(a.name, b.name))) {
    const arts = [...gn.albums].map(id => S.d.albums.get(id)).filter(a => a && a.art).slice(0, 4);
    const cover = h('div', { class: 'mosaic' + (arts.length < 4 ? ' one' : '') + (arts.length ? '' : ' icon'), style: { width: '100%', height: 'auto', aspectRatio: '1' }, html: arts.length ? '' : I.genre(44) });
    for (const a of (arts.length < 4 ? arts.slice(0, 1) : arts)) cover.append(h('div', { style: { backgroundImage: `url('vkmedia://app/~art/${a.art}')` } }));
    const tile = h('div', { class: 'tile' }, cover, h('div', { class: 'n' }, gn.name), h('div', { class: 'a' }, `${plural(gn.albums.size, 'album')}`));
    tile.onclick = () => go('genre:' + gn.name);
    g.append(tile);
  }
  v.append(g);
}
function viewGenre(v, name) {
  const gn = S.d.genres.get(name); if (!gn) return go('genres', { replace: true });
  const al = [...gn.albums].map(id => S.d.albums.get(id)).filter(Boolean).sort((a, b) => coll.compare(sortName(a.artist), sortName(b.artist)));
  const tr = al.flatMap(a => a.tracks).filter(t => (t.genre || 'Unknown Genre') === name);
  v.append(h('div', { class: 'head' }, h('div', {}, h('h1', {}, name), h('div', { class: 'meta' }, `${plural(al.length, 'album')}, ${plural(tr.length, 'song')}`)), h('div', { class: 'grow' }),
    h('button', { class: 'btn', onclick: () => playList(tr.map(t => t.id), 0, name) }, h('span', { html: I.play(11) }), 'Play'), h('button', { class: 'btn', onclick: () => playList(tr.map(t => t.id), 0, name, true) }, h('span', { html: I.shuffle(12) }), 'Shuffle')));
  albumTiles(v, al);
}
function viewArtists(v) {
  S.lastLib = 'artists';
  if (!S.tracks.size) return emptyLibrary(v);
  const artists = [...S.d.artists.values()].sort((a, b) => coll.compare(sortName(a.name), sortName(b.name)));
  if (!S.artist || !S.d.artists.has(S.artist)) S.artist = artists[0] && artists[0].name;
  const sp = h('div', { class: 'split' }), list = h('div', { class: 'list' }), det = h('div', { class: 'detail' });
  for (const a of artists) {
    const r = h('div', { class: 'row' + (a.name === S.artist ? ' sel' : '') }, h('div', { class: 'av', style: a.art ? { backgroundImage: `url('vkmedia://app/~art/${a.art}')` } : {}, html: a.art ? '' : I.artist(16) }), h('span', {}, a.name));
    r.onclick = () => { S.artist = a.name; list.querySelectorAll('.row').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); showArtist(det, a); };
    r.ondblclick = () => playList(artistTracks(a).map(t => t.id), 0, a.name);
    r.oncontextmenu = e => trackMenu(e, artistTracks(a).map(t => t.id), artistTracks(a));
    list.append(r);
  }
  sp.append(list, det); v.append(sp); v.style.overflow = 'hidden';
  const sel = S.d.artists.get(S.artist); if (sel) showArtist(det, sel);
  setTimeout(() => { const s = list.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'center' }); });
}
const artistTracks = a => [...a.albums].map(id => S.d.albums.get(id)).filter(Boolean).sort((x, y) => (x.year || 0) - (y.year || 0)).flatMap(al => al.tracks);
function showArtist(det, a) {
  det.innerHTML = ''; det.scrollTop = 0;
  const tr = artistTracks(a);
  det.append(h('div', { class: 'head' }, h('div', {}, h('h1', {}, a.name), h('div', { class: 'meta' }, `${plural(a.albums.size, 'album')}, ${plural(tr.length, 'song')}`)), h('div', { class: 'grow' }),
    h('button', { class: 'btn', onclick: () => playList(tr.map(t => t.id), 0, a.name, true) }, h('span', { html: I.shuffle(12) }), 'Shuffle')));
  for (const al of [...a.albums].map(id => S.d.albums.get(id)).filter(Boolean).sort((x, y) => (y.year || 0) - (x.year || 0))) {
    const rows = h('div');
    al.tracks.forEach((t, i) => {
      const r = h('div', { class: 'trk' + (P.cur === t.id ? ' now' : ''), 'data-id': t.id }, h('span', { class: 'no' }, t.track || ''), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, t.title), h('span', { class: 'du' }, fmtTime(t.duration)));
      r.ondblclick = () => playList(al.tracks.map(x => x.id), i, al.name);
      r.onclick = () => { det.querySelectorAll('.trk.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); S.sel = new Set([t.id]); };
      r.oncontextmenu = e => { S.sel = new Set([t.id]); trackMenu(e, [t.id], al.tracks); };
      rows.append(r);
    });
    det.append(h('div', { class: 'agroup' }, h('div', { class: 'cover', style: al.art ? { backgroundImage: `url('vkmedia://app/~art/${al.art}')`, cursor: 'pointer' } : {}, onclick: () => go('album:' + al.id) }),
      h('div', {}, h('h3', {}, al.name), h('div', { class: 'gy' }, [al.genre, al.year].filter(Boolean).join(' · ')), rows)));
  }
}
function viewAlbum(v, id) {
  const a = S.d.albums.get(id); if (!a) return go('albums', { replace: true });
  const box = h('div', { class: 'album' });
  const dur = a.tracks.reduce((x, t) => x + (t.duration || 0), 0);
  const list = h('div');
  const multi = new Set(a.tracks.map(t => t.disc || 1)).size > 1;
  let lastDisc = null;
  a.tracks.forEach((t, i) => {
    if (multi && t.disc !== lastDisc) { lastDisc = t.disc; list.append(h('div', { style: { fontSize: '12px', fontWeight: 600, padding: '12px 0 4px', opacity: .7 } }, `Disc ${t.disc || 1}`)); }
    const r = h('div', { class: 'trk' + (P.cur === t.id ? ' now' : ''), 'data-id': t.id }, h('span', { class: 'no' }, t.track || i + 1),
      h('span', { class: 'tt' }, t.title, t.artist && t.artist !== a.artist ? h('span', { style: { opacity: .6 } }, ' — ' + t.artist) : null),
      h('span', { html: stars(t) }), h('span', { class: 'du' }, fmtTime(t.duration)));
    r.ondblclick = () => playList(a.tracks.map(x => x.id), i, a.name);
    r.onclick = e => {
      const st = e.target.closest('.stars i'); if (st) { const n = +st.dataset.r; vk.libUpdate([t.id], { rating: Math.round((t.rating || 0) / 20) === n ? 0 : n * 20 }); return; }
      box.querySelectorAll('.trk.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); S.sel = new Set([t.id]);
    };
    r.oncontextmenu = e => { S.sel = new Set([t.id]); box.querySelectorAll('.trk.sel').forEach(x => x.classList.remove('sel')); r.classList.add('sel'); trackMenu(e, [t.id], a.tracks); };
    r.draggable = true; r.ondragstart = e => e.dataTransfer.setData('application/x-vk-tracks', JSON.stringify([t.id]));
    list.append(r);
  });
  const art = a.art ? `vkmedia://app/~art/${a.art}${a.artRev ? '?' + a.artRev : ''}` : '';
  box.append(h('div', {}, h('div', { class: 'big', style: { backgroundImage: art ? `url('${art}')` : '' } })),
    h('div', {}, h('h1', {}, a.name), h('div', { class: 'by', onclick: () => { S.artist = a.artist; go('artists'); } }, a.artist),
      h('div', { class: 'gy' }, [a.genre, a.year, plural(a.tracks.length, 'song'), fmtTotal(dur)].filter(Boolean).join(' · ')),
      h('div', { class: 'acts' }, h('button', { class: 'btn', onclick: () => playList(a.tracks.map(t => t.id), 0, a.name) }, h('span', { html: I.play(11) }), 'Play'),
        h('button', { class: 'btn', onclick: () => playList(a.tracks.map(t => t.id), 0, a.name, true) }, h('span', { html: I.shuffle(12) }), 'Shuffle'),
        h('button', { class: 'btn', onclick: e => trackMenu(e, a.tracks.map(t => t.id), a.tracks) }, '•••')),
      list));
  v.append(box);
  if (art) tint(art, box);
}
function tint(url, el) {
  const img = new Image(); img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24; const x = c.getContext('2d'); x.drawImage(img, 0, 0, 24, 24);
      const d = x.getImageData(0, 0, 24, 24).data; let r = 0, g = 0, b = 0, w = 0;
      for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); const wt = 1 + (mx - mn) / 64; r += d[i] * wt; g += d[i + 1] * wt; b += d[i + 2] * wt; w += wt; }
      r = Math.round(r / w); g = Math.round(g / w); b = Math.round(b / w);
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      el.style.setProperty('--ab', `rgb(${r},${g},${b})`);
      el.style.setProperty('--af', lum > .6 ? '#141414' : '#ffffff'); el.style.setProperty('--af2', lum > .6 ? 'rgba(0,0,0,.6)' : 'rgba(255,255,255,.7)');
    } catch (_) {}
  };
  img.src = url;
}
function viewPlaylist(v, id) {
  const p = S.playlists.find(x => x.id === id); if (!p) return go('songs', { replace: true });
  const tr = playlistTracks(p);
  const arts = [...new Set(tr.map(t => t.art).filter(Boolean))].slice(0, 4);
  const mos = h('div', { class: 'mosaic' + (arts.length && arts.length < 4 ? ' one' : '') + (arts.length ? '' : ' icon' + (p.smart ? ' smart' : '')), html: arts.length ? '' : (p.smart ? I.smart : I.playlist)(60) });
  for (const a of (arts.length < 4 ? arts.slice(0, 1) : arts)) mos.append(h('div', { style: { backgroundImage: `url('vkmedia://app/~art/${a}')` } }));
  const title = h('h1', { title: 'Double-click to rename' }, p.name); title.ondblclick = () => { S.renaming = p.id; renderSide(); };
  v.append(h('div', { class: 'plhead' }, mos, h('div', {}, title, h('div', { class: 'meta' }, `${plural(tr.length, 'song')}, ${fmtTotal(tr.reduce((a, t) => a + (t.duration || 0), 0))}${p.smart ? ' · Smart Playlist' : ''}`),
    h('div', { class: 'acts' }, h('button', { class: 'btn', disabled: !tr.length, onclick: () => playList(tr.map(t => t.id), 0, p.name) }, h('span', { html: I.play(11) }), 'Play'),
      h('button', { class: 'btn', disabled: !tr.length, onclick: () => playList(tr.map(t => t.id), 0, p.name, true) }, h('span', { html: I.shuffle(12) }), 'Shuffle'),
      p.smart ? h('button', { class: 'btn', onclick: () => smartDialog(p) }, 'Edit Rules') : null))));
  if (!tr.length) { v.append(h('div', { class: 'empty', style: { height: 'auto', paddingTop: '30px' } }, p.smart ? 'No songs match these rules yet.' : 'Drag songs here from your library, or right-click songs and choose Add to Playlist.')); return; }
  if (!p.smart) S.sortOverride = S.sortOverride && S.sortRoute === S.route; S.sortRoute = S.route;
  table(v, tr, { cols: ['now', 'num', 'title', 'duration', 'artist', 'album', 'genre', 'loved', 'rating', 'plays'], ordered: p.smart ? null : p, sortable: !p.smart || true });
  statusFor(tr);
}
function viewSearch(v) {
  const q = S.search.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hit = t => { const s = `${t.title} ${t.artist} ${t.albumArtist} ${t.album} ${t.genre} ${t.composer}`.toLowerCase(); return words.every(w => s.includes(w)); };
  const tr = all().filter(hit);
  const albums = [...S.d.albums.values()].filter(a => words.every(w => `${a.name} ${a.artist}`.toLowerCase().includes(w))).slice(0, 12);
  v.append(h('div', { class: 'head' }, h('h1', {}, `Results for “${S.search.trim()}”`)));
  if (albums.length) { v.append(h('div', { style: { padding: '6px 24px 0', fontWeight: 600 } }, 'Albums')); albumTiles(v, albums); }
  if (tr.length) { v.append(h('div', { style: { padding: '6px 24px 6px', fontWeight: 600 } }, 'Songs')); table(v, tr); statusFor(tr); }
  if (!tr.length && !albums.length) v.append(h('div', { class: 'empty', style: { height: 'auto', paddingTop: '40px' } }, 'No results'));
}

// ================================================================ views: phone
function deviceBy(serial) { return S.devices.find(d => d.serial === serial); }
function devSettings(serial) { return S.devEdit[serial] || (deviceBy(serial) || {}).settings || {}; }
function devDirty(serial) { const d = deviceBy(serial); return !!S.devEdit[serial] && d && JSON.stringify(S.devEdit[serial]) !== JSON.stringify(d.settings); }
function editDev(serial, patch) { S.devEdit[serial] = Object.assign({}, devSettings(serial), patch); updateDevBar(serial); }
function viewDevice(v, arg) {
  const [serial, page] = arg.split(':'); const d = deviceBy(serial);
  if (!d || d.state !== 'device') { v.append(h('div', { class: 'empty' }, h('div', { html: I.phone(56) }), h('h2', {}, 'Phone not connected'), h('div', {}, 'Connect your phone with USB and allow USB debugging.'))); return; }
  if (page === 'onphone') return viewOnPhone(v, d);
  const pg = h('div', { class: 'devpage' }); v.append(pg);
  if (page === 'music') musicPage(pg, d); else summaryPage(pg, d);
  const bar = h('div', { class: 'devbar', id: 'devbar' }); $('#main').append(bar); bar.dataset.serial = serial;
  updateDevBar(serial);
}
function summaryPage(pg, d) {
  if (!S.usageAsked || S.usageAsked !== d.serial) { S.usageAsked = d.serial; vk.devRefresh(d.serial, true).catch(() => {}); }
  const s = devSettings(d.serial);
  pg.append(h('div', { class: 'devtop' }, h('div', { class: 'phone' }), h('div', {},
    h('h1', {}, d.name || d.model),
    h('div', { class: 'kv' },
      h('b', {}, 'Capacity:'), h('span', {}, d.capacity ? fmtBytes(d.capacity) : '—'),
      h('b', {}, 'Model:'), h('span', {}, [d.brand, d.model].filter(Boolean).join(' ')),
      h('b', {}, 'Serial number:'), h('span', {}, d.serialNo || d.serial),
      h('b', {}, 'Android:'), h('span', {}, d.android ? `Android ${d.android}` : '—'),
      h('b', {}, 'System:'), h('span', {}, d.os || '—'),
      h('b', {}, 'Battery:'), h('span', {}, d.battery != null ? `${d.battery}%${d.charging ? ' (charging)' : ''}` : '—'),
      h('b', {}, 'Connection:'), h('span', {}, d.usb ? 'USB' : 'Wi-Fi (adb)'),
      h('b', {}, 'Last synced:'), h('span', {}, d.settings && d.settings.lastSync ? new Date(d.settings.lastSync).toLocaleString() : 'Never')))));
  const opt = (k, label, note) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: !!s[k], onchange: e => editDev(d.serial, { [k]: e.target.checked }) }), label, note ? h('span', { style: { color: 'var(--fg3)', fontSize: '11.5px' } }, ' ' + note) : null);
  pg.append(h('div', { class: 'section' }, h('h3', {}, 'Options'),
    opt('auto', 'Automatically sync when this phone is connected'),
    opt('convert', 'Convert higher bit rate songs to 256 kbps AAC', S.ffmpeg ? '(lossless and >320 kbps songs; saves space)' : '(needs ffmpeg)'),
    opt('m3u', 'Sync playlists as .m3u8 files', '(Music/Playlists on the phone, for music apps that read them)'),
    h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
      h('button', { class: 'btn', onclick: () => go(`device:${d.serial}:music`) }, h('span', { html: I.note(13) }), 'Music sync settings…'),
      h('button', { class: 'btn', onclick: () => vk.appLaunch('drive') }, h('span', { html: I.folder(13) }), 'Open Phone Drive'),
      h('button', { class: 'btn', onclick: () => vk.appLaunch('mirror') }, h('span', { html: I.mirror(13) }), 'Screen Mirroring'),
      h('button', { class: 'btn', onclick: () => vk.appLaunch('keymouse') }, h('span', { html: I.keyboard(13) }), 'Keyboard & Mouse'),
      h('button', { class: 'btn', onclick: () => go('office:albums') }, h('span', { html: I.photos(13) }), 'Photo Backup'))));
}
function musicPage(pg, d) {
  const s = devSettings(d.serial);
  pg.append(h('div', { class: 'section', style: { paddingTop: 0 } },
    h('label', { class: 'chk', style: { fontSize: '15px', fontWeight: 600 } }, h('input', { type: 'checkbox', checked: !!s.sync, onchange: e => { editDev(d.serial, { sync: e.target.checked }); render(); } }), 'Sync Music'),
    h('div', { class: 'radio' },
      h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'mode', disabled: !s.sync, checked: s.mode !== 'selected', onchange: () => { editDev(d.serial, { mode: 'all' }); render(); } }), 'Entire music library'),
      h('label', { class: 'chk' }, h('input', { type: 'radio', name: 'mode', disabled: !s.sync, checked: s.mode === 'selected', onchange: () => { editDev(d.serial, { mode: 'selected' }); render(); } }), 'Selected playlists, artists, albums, and genres')),
    h('div', { style: { color: 'var(--fg2)', fontSize: '12px', margin: '10px 0 0 24px' }, id: 'planNote' }, '')));
  if (s.sync && s.mode === 'selected') {
    const box = (title, items, key, render1, filter = true) => {
      const set = new Set(s[key] || []);
      const list = h('div', { class: 'items' });
      const fill = q => { list.innerHTML = ''; for (const it of items) { if (q && !it.label.toLowerCase().includes(q)) continue; list.append(h('label', {}, h('input', { type: 'checkbox', checked: set.has(it.id), onchange: e => { e.target.checked ? set.add(it.id) : set.delete(it.id); editDev(d.serial, { [key]: [...set] }); } }), render1 ? render1(it) : null, h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, it.label))); } };
      fill('');
      return h('div', { class: 'box' }, h('h5', {}, title, filter ? h('input', { type: 'search', placeholder: 'Filter', oninput: e => fill(e.target.value.toLowerCase()) }) : null), list);
    };
    pg.append(h('div', { class: 'boxes' },
      box('Playlists', S.playlists.map(p => ({ id: p.id, label: `${p.name} (${playlistTracks(p).length})` })), 'playlists', null, false),
      box('Artists', [...S.d.artists.values()].sort((a, b) => coll.compare(sortName(a.name), sortName(b.name))).map(a => ({ id: a.name, label: a.name })), 'artists'),
      box('Genres', [...S.d.genres.values()].sort((a, b) => coll.compare(a.name, b.name)).map(g => ({ id: g.name, label: g.name })), 'genres'),
      box('Albums', albumsSorted().map(a => ({ id: a.id, label: `${a.artist} – ${a.name}`, art: a.art })), 'albums', it => it.art ? h('img', { src: `vkmedia://app/~art/${it.art}`, loading: 'lazy' }) : h('span', { class: 'sw' }))));
  }
}
let planT = 0;
async function updateDevBar(serial) {
  const bar = $('#devbar'); if (!bar || bar.dataset.serial !== serial) return;
  const d = deviceBy(serial); if (!d) return;
  const dirty = devDirty(serial), syncing = S.sync && !S.sync.done;
  const u = d.usage || {}, cap = d.capacity || 0, used = d.used || 0;
  const known = (u.audio || 0) + (u.photos || 0) + (u.video || 0) + (u.documents || 0);
  const segs = [['Audio', u.audio, 'var(--cap-audio)'], ['Photos', u.photos, 'var(--cap-photos)'], ['Video', u.video, 'var(--cap-video)'], ['Documents', u.documents, 'var(--cap-docs)'], ['Apps & Other', Math.max(0, used - known), 'var(--cap-other)']];
  bar.innerHTML = '';
  const capEl = h('div', { class: 'cap' }, h('div', { class: 'bar' }, ...segs.map(([, n, c]) => h('i', { style: { width: cap ? (n || 0) / cap * 100 + '%' : 0, background: c } }))),
    h('div', { class: 'leg' }, ...segs.filter(([, n]) => n).map(([l, n, c]) => h('span', { style: { '--c': c } }, `${l} ${fmtBytes(n)}`)), cap ? h('span', { style: { '--c': 'var(--cap-free)' } }, `Free ${fmtBytes(d.free || 0)}`) : null));
  bar.append(capEl);
  if (dirty) bar.append(h('button', { class: 'btn', onclick: () => { delete S.devEdit[serial]; render(); } }, 'Revert'));
  bar.append(h('button', { class: 'btn primary', disabled: syncing, onclick: async () => { if (dirty) { await vk.devSettings(serial, S.devEdit[serial]); delete S.devEdit[serial]; } startSync(serial); } }, syncing ? 'Syncing…' : dirty ? 'Apply' : 'Sync'));
  // how much music the settings select
  clearTimeout(planT);
  planT = setTimeout(async () => {
    const note = $('#planNote'); if (!note) return;
    const s = devSettings(serial);
    if (!s.sync) { note.textContent = 'Music sync is off. Songs synced before stay on the phone until you sync with it on and deselect them.'; return; }
    if (devDirty(serial)) await vk.devSettings(serial, S.devEdit[serial]).then(() => { delete S.devEdit[serial]; });
    const p = await vk.devPlan(serial, resolvedPlaylists()); note.textContent = `${plural(p.count, 'song')} (about ${fmtBytes(p.bytes)}) will be on the phone, in Music/<Artist>/<Album>. Music you put on the phone another way is left alone.`;
    updateDevBarButtons(serial);
  }, 250);
}
function updateDevBarButtons(serial) { const bar = $('#devbar'); if (bar) { const b = bar.querySelector('.btn.primary'); if (b && !(S.sync && !S.sync.done)) b.textContent = devDirty(serial) ? 'Apply' : 'Sync'; } }
async function startSync(serial) {
  const d = deviceBy(serial); if (!d) return;
  const s = devSettings(serial);
  if (!s.sync) { toast('Turn on “Sync Music” first (Phone → Music)'); go(`device:${serial}:music`); return; }
  const res = resolvedPlaylists();
  const defs = (s.mode === 'selected' ? S.playlists.filter(p => (s.playlists || []).includes(p.id)) : S.playlists).map(p => ({ name: p.name, items: res[p.id] || [] }));
  S.sync = { name: d.name, label: 'Preparing to sync', step: 1, steps: 5 }; renderLcd();
  await vk.devSync(serial, res, defs);
}
async function viewOnPhone(v, d) {
  const tb = h('div', { class: 'toolbar' }, h('b', {}, `Music on ${d.name}`), h('div', { class: 'grow' }),
    h('button', { class: 'btn', onclick: () => { delete S.phoneList[d.serial]; render(); } }, h('span', { html: I.reload(13) }), 'Refresh'),
    h('button', { class: 'btn', id: 'impBtn', onclick: () => importSel(d) }, h('span', { html: I.download(13) }), 'Copy to Library'),
    h('button', { class: 'btn danger', onclick: () => deleteSel(d) }, h('span', { html: I.trash(13) }), 'Delete from Phone'));
  v.append(tb);
  if (!S.phoneList[d.serial]) {
    v.append(h('div', { class: 'empty', style: { height: 'auto', paddingTop: '50px' } }, h('div', { class: 'spin' }), 'Looking for music on the phone…'));
    try { S.phoneList[d.serial] = await vk.devPhoneMusic(d.serial); } catch (e) { S.phoneList[d.serial] = []; toast('Couldn\'t list the phone\'s music: ' + e.message); }
    if (S.route === `device:${d.serial}:onphone`) render();
    return;
  }
  const items = S.phoneList[d.serial];
  if (!items.length) { v.append(h('div', { class: 'empty', style: { height: 'auto', paddingTop: '50px' } }, 'No music found on the phone.')); return; }
  const PC = {
    title: { w: 'minmax(160px,2fr)', label: 'Name', sort: (a, b) => coll.compare(a.title, b.title) },
    artist: { w: 'minmax(100px,1fr)', label: 'Artist', sort: (a, b) => coll.compare(a.artist, b.artist) },
    album: { w: 'minmax(100px,1fr)', label: 'Album', sort: (a, b) => coll.compare(a.album, b.album) },
    size: { w: '80px', label: 'Size', cls: 'dur', get: f => fmtBytes(f.size), sort: (a, b) => a.size - b.size },
    synced: { w: '70px', label: 'Source', get: f => f.synced ? '<span class="tag">synced</span>' : '', html: true, sort: (a, b) => (b.synced ? 1 : 0) - (a.synced ? 1 : 0) },
    path: { w: 'minmax(140px,1.6fr)', label: 'Location', get: f => f.path.replace(/^\/sdcard\//, ''), sort: (a, b) => coll.compare(a.path, b.path) },
  };
  if (!PC[S.sort.key]) S.sort = { key: 'path', dir: 1 };
  table(v, items, { cols: ['title', 'artist', 'album', 'size', 'synced', 'path'], colDefs: PC, keyOf: f => f.path,
    onOpen: async f => { try { toast('Loading from the phone…', 1500); const url = await vk.devPreview(d.serial, f.path); P.cur = null; audio.src = url; ensureGraph(); audio.play(); $('#lcd').innerHTML = `<div class="logo" style="gap:8px">${I.phone(16)} <span style="font-size:12px">${esc(f.title)} (from phone)</span></div>`; lcdMode = 'preview'; } catch (e) { toast(e.message); } },
    onMenu: (e, keys) => menu(e, [{ label: 'Copy to Library', fn: () => importSel(d) }, { label: 'Delete from Phone', fn: () => deleteSel(d) }]) });
  $('#status').textContent = `${plural(items.length, 'file')}, ${fmtBytes(items.reduce((a, f) => a + f.size, 0))}`;
}
async function importSel(d) {
  const paths = [...S.sel]; if (!paths.length) return toast('Select songs first');
  toast(`Copying ${plural(paths.length, 'song')} to your library…`);
  try { const n = await vk.devImport(d.serial, paths); toast(`Copied ${plural(n, 'song')} into your library`); } catch (e) { toast('Import failed: ' + e.message); }
}
function deleteSel(d) {
  const paths = [...S.sel]; if (!paths.length) return toast('Select songs first');
  dialog(`Delete ${plural(paths.length, 'song')} from the phone?`, h('div', { style: { color: 'var(--fg2)' } }, 'The files are deleted from the phone. This can\'t be undone.'),
    [{ label: 'Cancel' }, { label: 'Delete', primary: true, fn: async () => { await vk.devDelete(d.serial, paths); const set = new Set(paths); S.phoneList[d.serial] = (S.phoneList[d.serial] || []).filter(f => !set.has(f.path)); S.sel.clear(); render(); } }]);
}

// ================================================================ views: Office Kit + Google
function viewOffice(v) { v.append(h('div', { class: 'office-note' }, 'Opening Office Kit…')); }
function viewGoogle(v, k) {
  S.lastGoogle = k;
  const g = S.google || {};
  v.style.overflow = 'hidden';
  v.append(h('div', { class: 'gbar' },
    h('button', { class: 'ibtn', title: 'Back', disabled: !(g.key === k && g.back), html: I.back(15), onclick: () => vk.appGoogle('back') }),
    h('button', { class: 'ibtn', title: 'Forward', disabled: !(g.key === k && g.fwd), html: I.fwd(15), onclick: () => vk.appGoogle('forward') }),
    h('button', { class: 'ibtn', title: 'Reload', html: g.loading && g.key === k ? '<div class="spin"></div>' : I.reload(15), onclick: () => vk.appGoogle('reload') }),
    h('div', { class: 'u' }, g.key === k ? (g.title || g.url || '') : S.services[k].name),
    h('button', { class: 'btn', onclick: () => vk.appGoogle('external') }, h('span', { html: I.external(12) }), 'Open in Browser')));
}

// ================================================================ dialogs
// Escape closes the top dialog wherever the focus is
document.addEventListener('keydown', e => { if (e.key !== 'Escape') return; const scs = document.querySelectorAll('.scrim'); if (scs.length) { e.stopImmediatePropagation(); scs[scs.length - 1].__close(); } }, true);
function dialog(title, body, buttons, { wide } = {}) {
  const sc = h('div', { class: 'scrim' });
  const close = () => { sc.remove(); vk.appPane(paneOf(), mainRect()); };
  const dl = h('div', { class: 'dlg', style: wide ? { width: 'min(760px,94vw)' } : {} }, h('header', {}, title), h('div', { class: 'bd' }, body),
    h('footer', {}, ...buttons.map(b => b === '|' ? h('div', { class: 'grow' }) : h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), onclick: async () => { if (b.fn && (await b.fn()) === false) return; close(); } }, b.label))));
  sc.__close = close;
  sc.append(dl); sc.addEventListener('mousedown', e => { if (e.target === sc) close(); });
  sc.addEventListener('keydown', e => { if (e.key === 'Escape') close(); e.stopPropagation(); });
  document.body.append(sc);
  vk.appPane('music');   // docked windows would cover the dialog
  setTimeout(() => { const f = dl.querySelector('input,select,button.primary'); if (f) f.focus(); });
  return close;
}
const paneOf = () => { const k = S.route.split(':')[0]; return k === 'office' ? 'office' : k === 'google' ? 'google:' + S.route.slice(7) : 'music'; };
function infoDialog(ids) {
  ids = ids.filter(id => S.tracks.has(id)); if (!ids.length) return;
  const ts = ids.map(id => S.tracks.get(id)), one = ts.length === 1, t0 = ts[0];
  const same = k => ts.every(t => (t[k] || '') === (t0[k] || '')) ? (t0[k] || '') : null;
  const F = {}, form = h('div', { class: 'form' });
  const field = (k, label, type = 'text') => { const v = same(k); const inp = h('input', { type, value: v == null ? '' : v, placeholder: v == null ? 'Mixed' : '' }); inp.dataset.orig = v == null ? '\u0000' : String(v); F[k] = inp; form.append(h('label', {}, label), inp); };
  if (one) field('title', 'Name');
  field('artist', 'Artist'); field('albumArtist', 'Album Artist'); field('album', 'Album'); field('genre', 'Genre'); field('composer', 'Composer'); field('year', 'Year', 'number');
  const pair = (a, b, label) => { const x = h('input', { type: 'number', value: same(a) || '' }), y = h('input', { type: 'number', value: same(b) || '' }); x.dataset.orig = String(same(a) || ''); y.dataset.orig = String(same(b) || ''); F[a] = x; F[b] = y; form.append(h('label', {}, label), h('div', { class: 'pair' }, x, 'of', y)); };
  if (one) pair('track', 'trackTotal', 'Track'); pair('disc', 'discTotal', 'Disc');
  const comp = h('input', { type: 'checkbox', checked: ts.every(t => t.compilation) }); form.append(h('label', {}, 'Compilation'), h('label', { class: 'chk', style: { textAlign: 'left', color: 'var(--fg)' } }, comp, 'Album is a compilation of songs by various artists'));
  const write = h('input', { type: 'checkbox', checked: S.ffmpeg && S.settings.writeTags !== false, disabled: !S.ffmpeg });
  const top = h('div', { class: 'infotop' }, h('div', { class: 'c', style: { backgroundImage: t0.art ? `url('${artUrl(t0)}')` : '' } }),
    h('div', {}, h('div', { style: { fontWeight: 600, fontSize: '15px' } }, one ? t0.title : `${ts.length} songs`), h('div', { style: { color: 'var(--fg2)' } }, one ? [t0.artist, t0.album].filter(Boolean).join(' — ') : ''),
      one ? h('div', { style: { color: 'var(--fg3)', fontSize: '11.5px', marginTop: '4px' } }, `${t0.kind || ''} · ${fmtTime(t0.duration)} · ${t0.bitrate ? t0.bitrate + ' kbps' : ''} · ${t0.sampleRate ? (t0.sampleRate / 1000).toFixed(1) + ' kHz' : ''} · ${fmtBytes(t0.size)} · played ${t0.plays || 0}×`) : null,
      one ? h('div', { style: { color: 'var(--fg3)', fontSize: '11px', wordBreak: 'break-all', userSelect: 'text' } }, t0.path) : null,
      h('button', { class: 'btn', style: { marginTop: '6px' }, onclick: async () => { if (await vk.libSetArtwork(ids)) toast('Artwork updated'); } }, 'Change Artwork…')));
  dialog(one ? 'Song Info' : 'Multiple Song Info', h('div', {}, top, form, h('label', { class: 'chk', style: { marginTop: '12px', color: 'var(--fg2)', fontSize: '12px' } }, write, S.ffmpeg ? 'Also save the changes into the music files (so the phone shows them too)' : 'Saving into the files needs ffmpeg (sudo pacman -S ffmpeg)')),
    [{ label: 'Cancel' }, { label: 'OK', primary: true, fn: async () => {
      const ch = {};
      for (const [k, inp] of Object.entries(F)) { if (inp.value === inp.dataset.orig || (inp.dataset.orig === '\u0000' && inp.value === '')) continue; ch[k] = inp.type === 'number' ? (+inp.value || 0) : inp.value.trim(); }
      if (comp.checked !== ts.every(t => t.compilation)) ch.compilation = comp.checked;
      vk.libSetSettings({ writeTags: write.checked }); S.settings.writeTags = write.checked;
      if (!Object.keys(ch).length) return;
      const r = await vk.libEditTags(ids, ch, write.checked);
      if (r && r.failed && r.failed.length) toast('Some files couldn\'t be updated: ' + r.failed[0], 6000);
    } }]);
}
function smartDialog(p) {
  const isNew = !p;
  const d = p ? JSON.parse(JSON.stringify(p)) : { id: uid(), name: 'Smart Playlist', smart: true, rules: { match: 'all', conds: [{ f: 'artist', op: 'contains', v: '' }], limit: { on: false, n: 25, by: 'random' } } };
  d.rules.limit = d.rules.limit || { on: false, n: 25, by: 'random' };
  const wrap = h('div');
  const draw = () => {
    wrap.innerHTML = '';
    const name = h('input', { type: 'text', value: d.name, style: { width: '100%', marginBottom: '12px' }, oninput: e => { d.name = e.target.value; } });
    const match = h('select', { onchange: e => { d.rules.match = e.target.value; } }, h('option', { value: 'all', selected: d.rules.match !== 'any' }, 'all'), h('option', { value: 'any', selected: d.rules.match === 'any' }, 'any'));
    wrap.append(name, h('div', { style: { margin: '0 0 8px' } }, 'Match ', match, ' of the following rules:'));
    d.rules.conds.forEach((c, i) => {
      const type = (FIELDS[c.f] || FIELDS.artist)[1];
      const fsel = h('select', { onchange: e => { c.f = e.target.value; c.op = OPS[FIELDS[c.f][1]][0][0]; c.v = ''; draw(); } }, ...Object.entries(FIELDS).map(([k, [l]]) => h('option', { value: k, selected: k === c.f }, l)));
      const osel = h('select', { onchange: e => { c.op = e.target.value; } }, ...OPS[type].map(([k, l]) => h('option', { value: k, selected: k === c.op }, l)));
      const val = type === 'bool' ? h('span') : h('input', { type: type === 'text' ? 'text' : 'number', value: c.v == null ? '' : c.v, oninput: e => { c.v = e.target.value; } });
      if (type === 'text' && ['artist', 'albumArtist', 'genre', 'album'].includes(c.f)) { const dl = h('datalist', { id: 'dl' + i }, ...[...new Set(all().map(t => t[c.f]).filter(Boolean))].sort(coll.compare).slice(0, 500).map(x => h('option', { value: x }))); val.setAttribute('list', 'dl' + i); wrap.append(dl); }
      wrap.append(h('div', { class: 'rule' }, fsel, osel, val,
        h('button', { class: 'btn', title: 'Remove rule', disabled: d.rules.conds.length < 2, onclick: () => { d.rules.conds.splice(i, 1); draw(); }, html: I.minus(12) }),
        h('button', { class: 'btn', title: 'Add rule', onclick: () => { d.rules.conds.splice(i + 1, 0, { f: 'artist', op: 'contains', v: '' }); draw(); }, html: I.plus(12) })));
    });
    const L = d.rules.limit;
    wrap.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '12px' } },
      h('input', { type: 'checkbox', checked: L.on, onchange: e => { L.on = e.target.checked; } }), 'Limit to',
      h('input', { type: 'number', value: L.n, style: { width: '64px' }, oninput: e => { L.n = +e.target.value; } }), 'songs selected by',
      h('select', { onchange: e => { L.by = e.target.value; } }, ...[['random', 'random'], ['plays', 'most often played'], ['added', 'most recently added'], ['lastPlayed', 'most recently played'], ['rating', 'highest rating'], ['name', 'name']].map(([k, l]) => h('option', { value: k, selected: L.by === k }, l)))));
  };
  draw();
  dialog(isNew ? 'New Smart Playlist' : 'Edit Smart Playlist', wrap, [{ label: 'Cancel' }, { label: 'OK', primary: true, fn: () => {
    if (isNew) S.playlists.push(d); else Object.assign(p, d);
    savePlaylists(); go('playlist:' + d.id); if (!isNew) render();
  } }], { wide: true });
}
function eqDialog() {
  const e = eqSettings();
  const wrap = h('div');
  const sliders = [];
  const on = h('input', { type: 'checkbox', checked: e.on, onchange: () => save() });
  const preset = h('select', { onchange: ev => { const b = EQ_PRESETS[ev.target.value]; if (b) b.forEach((x, i) => { sliders[i].value = x; }); save(); } }, ...Object.keys(EQ_PRESETS).map(k => h('option', { value: k, selected: k === e.preset }, k)), h('option', { value: 'Manual', selected: !EQ_PRESETS[e.preset] }, 'Manual'));
  const preamp = h('input', { type: 'range', min: -12, max: 12, step: .5, value: e.pre, oninput: () => save() });
  const eqEl = h('div', { class: 'eq' }, h('div', { class: 'band' }, preamp, 'Preamp'), h('div', { class: 'sep' }));
  EQ_FREQ.forEach((f, i) => { const s = h('input', { type: 'range', min: -12, max: 12, step: .5, value: e.bands[i], oninput: () => { preset.value = 'Manual'; save(); } }); sliders.push(s); eqEl.append(h('div', { class: 'band' }, s, f >= 1000 ? f / 1000 + 'K' : String(f))); });
  function save() { const n = { on: on.checked, preset: preset.value, pre: +preamp.value, bands: sliders.map(s => +s.value) }; S.settings.eq = n; applyEq(); vk.libSetSettings({ eq: n }); }
  wrap.append(h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, h('label', { class: 'chk' }, on, 'On'), h('div', { style: { flex: 1 } }), preset), eqEl,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--fg3)', padding: '0 4px' } }, '+12 dB … −12 dB'));
  dialog('Equalizer', wrap, [{ label: 'Done', primary: true }]);
}
function prefsDialog() {
  let selF = null;
  const box = h('div', { class: 'folders' });
  const fill = () => { box.innerHTML = ''; for (const f of S.folders) { const r = h('div', { class: f === selF ? 'sel' : '' }, f); r.onclick = () => { selF = f; fill(); }; r.ondblclick = () => vk.libOpenFolder(f); box.append(r); } if (!S.folders.length) box.append(h('div', { style: { color: 'var(--fg3)' } }, 'No folders yet')); };
  fill();
  const theme = h('select', { onchange: e => setTheme(e.target.value) }, ...['system', 'light', 'dark'].map(t => h('option', { value: t, selected: (S.settings.theme || 'system') === t }, t[0].toUpperCase() + t.slice(1))));
  const vivoSide = h('input', { type: 'checkbox', checked: !!S.settings.vivoSidebar, onchange: e => { S.settings.vivoSidebar = e.target.checked; vk.libSetSettings({ vivoSidebar: e.target.checked }); } });
  dialog('Preferences', h('div', {},
    h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, 'Music folders'),
    h('div', { style: { color: 'var(--fg2)', fontSize: '12px', marginBottom: '8px' } }, 'Songs in these folders (and their subfolders) are in your library. Files are never moved or copied.'),
    box,
    h('div', { style: { display: 'flex', gap: '6px', margin: '8px 0 18px' } },
      h('button', { class: 'btn', onclick: async () => { await vk.libAddFolder(); S.folders = (await vk.libGet()).folders; fill(); } }, 'Add Folder…'),
      h('button', { class: 'btn', onclick: async () => { if (!selF) return; await vk.libRemoveFolder(selF); S.folders = S.folders.filter(f => f !== selF); selF = null; fill(); } }, 'Remove'),
      h('button', { class: 'btn', onclick: () => { vk.libScan(); toast('Updating library…'); } }, 'Update Library')),
    h('div', { class: 'form' }, h('label', {}, 'Appearance'), theme,
      h('label', {}, 'Office Kit'), h('label', { class: 'chk', style: { textAlign: 'left', color: 'var(--fg)' } }, vivoSide, 'Also show Office Kit\'s own sidebar'),
      h('label', {}, 'Google'), h('div', {}, h('button', { class: 'btn', onclick: () => { vk.appGoogle('signout'); toast('Signed out of Google in this app'); } }, 'Sign Out of Google')),
      h('label', {}, 'Equalizer'), h('div', {}, h('button', { class: 'btn', onclick: eqDialog }, 'Equalizer…')))),
    [{ label: 'Open Logs', fn: () => { vk.appLogs(); return false; } }, '|', { label: 'Done', primary: true }]);
}

// ================================================================ events from the main process
function applyTracks({ upsert = [], removed = [] }) {
  for (const t of upsert) S.tracks.set(t.id, t);
  for (const id of removed) S.tracks.delete(id);
  derive();
  clearTimeout(applyTracks.t);
  applyTracks.t = setTimeout(() => {
    const k = S.route.split(':')[0];
    if (['device', 'office', 'google'].includes(k)) { if (k === 'device') updateDevBar(S.route.split(':')[1]); return; }
    const v = $('#view'), st = v.scrollTop, sel = S.sel; render(); S.sel = sel; v.scrollTop = st; if (TBL) TBL.draw();
  }, upsert.length === 1 && !removed.length ? 0 : 250);
  if (P.cur && upsert.some(t => t.id === P.cur)) renderLcd();
}
vk.on('lib:tracks', applyTracks);
vk.on('lib:scan', d => {
  S.scan = d;
  if (!S.tracks.size && ['albums', 'songs', 'artists', 'recent', 'genres'].includes(S.route)) render();
  if (d.finished) { S.scan = null; if (/^Updating library/.test($('#status').textContent)) $('#status').textContent = ''; } else if (d.total > 20 && !['device', 'office', 'google'].includes(S.route.split(':')[0])) $('#status').textContent = `Updating library: ${d.done} of ${d.total} files`;
});
vk.on('dev:devices', d => {
  const before = connectedDevice();
  S.devices = d.list || []; if (d.adbMissing != null) S.adbMissing = d.adbMissing;
  const now = connectedDevice();
  renderSide(); renderSub();
  if (now && (!before || before.serial !== now.serial)) toast(`${now.name || 'Phone'} connected`);
  const k = S.route.split(':');
  if (k[0] === 'device') { if (!now || now.serial !== k[1]) render(); else if (k[2] === 'summary' && !S.devEdit[k[1]]) { const v = $('#view'), st = v.scrollTop; render(); $('#view').scrollTop = st; } else updateDevBar(k[1]); }
});
vk.on('dev:sync', d => {
  S.sync = Object.assign({}, S.sync || {}, d);
  if (d.done) { S.sync = Object.assign({}, d); if (!d.error) toast(d.label + (d.copied != null ? ` — ${plural(d.copied, 'item')} copied${d.removed ? `, ${d.removed} removed` : ''}` : '')); else toast(`${d.label}: ${d.error}`, 6000); setTimeout(() => { if (S.sync && S.sync.done) { S.sync = null; renderLcd(); } }, 8000); const s = S.route.split(':'); if (s[0] === 'device') { delete S.phoneList[s[1]]; updateDevBar(s[1]); } }
  renderLcd();
});
vk.on('google:state', g => { S.google = g; if (S.route === 'google:' + g.key) { const v = $('#view'); v.innerHTML = ''; viewGoogle(v, g.key); } });
vk.on('app:pane', p => { if (p.startsWith('google:')) go(p); });
vk.on('app:maximized', m => { $('#maxBtn').innerHTML = (m ? I.restore : I.max)(14); });

// ================================================================ keyboard, drag & drop, wiring
addEventListener('keydown', e => {
  const typing = e.target.closest('input,textarea,select');
  const c = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { closeMenu(); closeUpNext(); if (S.search) { $('#search').value = ''; S.search = ''; go(S.back.pop() || 'albums', { noHistory: true }); } return; }
  if (c && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (c && e.key.toLowerCase() === 'q') { e.preventDefault(); vk.appWin('quit'); return; }
  if (c && e.key.toLowerCase() === 'w') { e.preventDefault(); vk.appWin('close'); return; }
  if (c && e.key === ',') { e.preventDefault(); prefsDialog(); return; }
  if (typing) return;
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (c && e.key === 'ArrowRight') { e.preventDefault(); next(); }
  else if (c && e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
  else if (c && e.key === 'ArrowUp') { e.preventDefault(); setVol(audio.volume + .1); }
  else if (c && e.key === 'ArrowDown') { e.preventDefault(); setVol(audio.volume - .1); }
  else if (c && e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); smartDialog(); }
  else if (c && e.key.toLowerCase() === 'n') { e.preventDefault(); newPlaylist(); }
  else if (c && e.key.toLowerCase() === 'o') { e.preventDefault(); addFiles(); }
  else if (c && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); }
  else if (c && e.key.toLowerCase() === 'i') { e.preventDefault(); if (S.sel.size && !S.route.startsWith('device:')) infoDialog([...S.sel]); }
  else if (c && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); eqDialog(); }
  else if (c && e.altKey && e.key.toLowerCase() === 'u') { e.preventDefault(); toggleUpNext(); }
  else if (c && e.key.toLowerCase() === 's') { e.preventDefault(); toggleShuffle(); }
  else if (c && e.key.toLowerCase() === 'r') { e.preventDefault(); P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; renderTop(); saveSettingsSoon(); }
  else if (e.key === 'Enter' && S.sel.size && TBL) { const ids = TBL.list.map(TBL.keyOf); if (S.route.split(':')[0] !== 'device') playList(ids, ids.indexOf([...S.sel][0]), routeTitle()); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel.size && !S.route.startsWith('device:')) {
    const pl = S.route.startsWith('playlist:') && S.playlists.find(p => p.id === S.route.slice(9));
    if (pl && !pl.smart) { const sel = new Set(S.sel); pl.items = pl.items.filter(id => !sel.has(id)); savePlaylists(); render(); } else deleteTracks([...S.sel]);
  } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && TBL && document.querySelector('.table')) {
    e.preventDefault(); const L = TBL.list; let i = L.findIndex(t => TBL.keyOf(t) === S.anchor); i = Math.max(0, Math.min(L.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
    const k = TBL.keyOf(L[i]); if (e.shiftKey) S.sel.add(k); else S.sel = new Set([k]); S.anchor = k;
    const v = $('#view'), body = document.querySelector('.table > div:nth-child(2)'); const top = body.offsetTop + i * 24; if (top < v.scrollTop + 24) v.scrollTop = top - 24; else if (top + 24 > v.scrollTop + v.clientHeight) v.scrollTop = top + 48 - v.clientHeight;
    TBL.draw();
  }
});
let dragDepth = 0;
addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
addEventListener('dragleave', e => { if (e.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
addEventListener('drop', async e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const paths = [...e.dataTransfer.files].map(f => f.path || vk.filePath(f)).filter(Boolean);
  if (!paths.length) return;
  toast('Adding to your library…');
  const r = await vk.libAddPaths(paths); if (r) toast(`Added ${plural(r.added, 'song')}`);
});

function wire() {
  $('#menuBtn').innerHTML = I.menu(18); $('#menuBtn').onclick = appMenu;
  $('#prevBtn').innerHTML = I.prev(20); $('#prevBtn').onclick = prev;
  $('#nextBtn').innerHTML = I.next(20); $('#nextBtn').onclick = () => next();
  $('#playBtn').onclick = togglePlay;
  $('#shuffleBtn').onclick = toggleShuffle;
  $('#repeatBtn').onclick = () => { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; renderTop(); saveSettingsSoon(); };
  $('#upNextBtn').innerHTML = I.list(17); $('#upNextBtn').onclick = toggleUpNext;
  $('#vol').oninput = e => setVol(+e.target.value);
  $('#volIcon').onclick = () => setVol(audio.volume ? 0 : .8);
  $('#searchIcon').innerHTML = I.search(13);
  $('#minBtn').innerHTML = I.min(14); $('#minBtn').onclick = () => vk.appWin('min');
  $('#maxBtn').innerHTML = I.max(14); $('#maxBtn').onclick = () => vk.appWin('max');
  $('#closeBtn').innerHTML = I.close(14); $('#closeBtn').onclick = () => vk.appWin('close');
  document.querySelector('.top').ondblclick = e => { if (e.target.classList.contains('spacer') || e.target.classList.contains('top')) vk.appWin('max'); };
  $('#backBtn').innerHTML = I.back(13); $('#fwdBtn').innerHTML = I.fwd(13);
  $('#backBtn').onclick = () => { if (!S.back.length) return; S.fwd.push(S.route); go(S.back.pop(), { noHistory: true }); };
  $('#fwdBtn').onclick = () => { if (!S.fwd.length) return; S.back.push(S.route); go(S.fwd.pop(), { noHistory: true }); };
  $('#picker').onclick = e => menu(null, [{ label: 'Music', fn: () => goGroup('library') }, { label: 'Phone', disabled: !connectedDevice(), fn: () => goGroup('phone') }, { label: 'Office Kit', fn: () => goGroup('office') }, { label: 'Google', fn: () => goGroup('google') }],
    { x: e.currentTarget.getBoundingClientRect().left, y: e.currentTarget.getBoundingClientRect().bottom + 2 });
  $('#devchip').onclick = () => goGroup('phone');
  let st = 0;
  $('#search').oninput = e => {
    clearTimeout(st); const q = e.target.value;
    st = setTimeout(() => { S.search = q; if (q.trim()) { if (!S.route.startsWith('search')) { S.back.push(S.route); S.fwd = []; } S.route = 'search'; render(); } else if (S.route === 'search') go(S.back.pop() || 'albums', { noHistory: true }); }, 180);
  };
}

async function init() {
  wire();
  const d = await vk.libGet();
  for (const t of d.tracks) S.tracks.set(t.id, t);
  S.settings = d.settings || {}; S.services = d.services || {}; S.ffmpeg = !!(d.platform && d.platform.ffmpeg); S.folders = d.folders || [];
  S.playlists = d.playlists && d.playlists.length ? d.playlists : (S.settings.playlistsInit ? [] : defaultPlaylists());
  if (!S.settings.playlistsInit) { vk.libSetPlaylists(S.playlists); vk.libSetSettings({ playlistsInit: true }); }
  if (S.settings.theme && S.settings.theme !== 'system') document.documentElement.dataset.theme = S.settings.theme;
  audio.volume = S.settings.volume != null ? S.settings.volume : .8; $('#vol').value = audio.volume;
  P.shuffle = !!S.settings.shuffle; P.repeat = S.settings.repeat || 'off';
  derive();
  if (!S.tracks.size && S.folders.length) S.scan = { done: 0, total: 0 };   // first scan starts right after launch
  const dv = await vk.devList(); S.devices = dv.list || []; S.adbMissing = dv.adbMissing;
  S.route = S.tracks.size ? 'albums' : 'albums';
  renderTop(); renderLcd(); render();
}
init();
