// Photos page: the phone's photos and videos in a Google Photos-style timeline (days, justified rows), with
// Photos / Videos / Albums tabs, multi-select, a full-screen viewer, download to the PC and delete from the phone.
'use strict';
/* global vk, I, S, h, $, esc, fmtBytes, fmtTime, plural, toast, dialog */

const PH = {};                                   // serial -> { items, loading, error, tab, album, sel, zoom, anchor }
const ZOOMS = [120, 160, 210, 280];
function phState(serial) { return PH[serial] = PH[serial] || { items: null, loading: false, error: '', tab: 'photos', album: null, sel: new Set(), zoom: 2, anchor: null }; }
const thumbUrl = (serial, id) => `vkmedia://app/~pthumb/${encodeURIComponent(serial)}/${id}`;
const fullUrl = (serial, id) => `vkmedia://app/~pfull/${encodeURIComponent(serial)}/${id}`;

function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const day0 = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(d)) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { weekday: 'short', month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
const aspect = it => (it.w && it.h ? Math.min(3, Math.max(0.33, it.w / it.h)) : 1);

async function loadPhotos(serial, force) {
  const st = phState(serial);
  if (st.loading || (st.items && !force)) return;
  st.loading = true; st.error = '';
  try { st.items = await vk.phList(serial); }
  catch (e) { st.error = String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  st.loading = false;
  if (S.route === `device:${serial}:photos`) render();
}

function viewPhotos(v, d) {
  const serial = d.serial, st = phState(serial);
  v.classList.add('gp-view');
  if (!st.items) {
    loadPhotos(serial);
    v.append(h('div', { class: 'empty' }, st.error ? [h('h2', {}, 'Couldn’t read the phone’s photos'), h('div', {}, st.error), h('button', { class: 'btn', style: { marginTop: '12px' }, onclick: () => { st.error = ''; loadPhotos(serial, true); render(); } }, 'Try Again')]
      : [h('div', { class: 'spinner' }), h('div', {}, `Reading photos on ${d.name || 'the phone'}…`)]));
    return;
  }
  const items = st.items;
  const shown = st.tab === 'videos' ? items.filter(i => i.kind === 'video') : st.album != null ? items.filter(i => i.album === st.album) : items;

  // ---- header (Google Photos style; turns into the selection bar while items are selected)
  const head = h('div', { class: 'gp-head' });
  const redraw = () => { const sc = v.scrollTop; render(); $('#view').scrollTop = sc; };
  if (st.sel.size) {
    head.classList.add('selecting');
    head.append(h('button', { class: 'ibtn', title: 'Clear selection (Esc)', html: I.close(16), onclick: () => { st.sel.clear(); redraw(); } }),
      h('div', { class: 'gp-title' }, `${st.sel.size.toLocaleString()} selected`), h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => downloadPhotos(serial, [...st.sel]) }, h('span', { html: I.download(14) }), 'Download'),
      h('button', { class: 'btn danger', onclick: () => deletePhotos(serial, [...st.sel]) }, h('span', { html: I.trash(14) }), 'Delete from phone'));
  } else {
    const nI = items.filter(i => i.kind === 'image').length, nV = items.length - nI;
    const title = st.album != null ? h('div', { class: 'gp-title' }, h('button', { class: 'ibtn', title: 'Albums', html: I.back(16), onclick: () => { st.album = null; st.tab = 'albums'; render(); } }), st.album)
      : h('div', { class: 'gp-title' }, { photos: 'Photos', videos: 'Videos', albums: 'Albums' }[st.tab]);
    head.append(...[title, h('div', { class: 'gp-sub' }, `${d.name || 'Phone'} · ${plural(nI, 'photo')}, ${plural(nV, 'video')}`), h('div', { class: 'grow' }),
      h('div', { class: 'gp-tabs' }, ...[['photos', 'Photos'], ['videos', 'Videos'], ['albums', 'Albums']].map(([k, l]) =>
        h('button', { class: st.tab === k && st.album == null ? 'on' : '', onclick: () => { st.tab = k; st.album = null; st.sel.clear(); render(); } }, l))),
      st.tab !== 'albums' || st.album != null ? h('div', { class: 'gp-zoom' },
        h('button', { class: 'ibtn', title: 'Smaller', disabled: st.zoom === 0, onclick: () => { st.zoom--; redraw(); } }, '−'),
        h('button', { class: 'ibtn', title: 'Larger', disabled: st.zoom === ZOOMS.length - 1, onclick: () => { st.zoom++; redraw(); } }, '+')) : null,
      h('button', { class: 'ibtn', title: 'Refresh', html: I.reload(15), onclick: () => { st.items = null; st.sel.clear(); loadPhotos(serial, true); render(); } })].filter(Boolean));
  }
  v.append(head);

  if (st.tab === 'albums' && st.album == null) return albumGrid(v, serial, items);
  if (!shown.length) { v.append(h('div', { class: 'empty' }, h('div', { html: I.photos(48) }), h('h2', {}, st.tab === 'videos' ? 'No videos' : 'No photos'))); return; }

  // ---- timeline: one section per day, justified rows inside
  const body = h('div', { class: 'gp-body' }); v.append(body);
  const width = Math.max(300, v.clientWidth - 48), H = ZOOMS[st.zoom], GAP = 4;
  const groups = [];
  for (const it of shown) { const k = dayKey(it.date); if (!groups.length || groups[groups.length - 1].k !== k) groups.push({ k, date: it.date, items: [] }); groups[groups.length - 1].items.push(it); }
  const order = shown;                                    // for shift-select and the viewer
  for (const g of groups) {
    const allSel = g.items.every(i => st.sel.has(i.id));
    const sec = h('section', { class: 'gp-day' });
    sec.append(h('div', { class: 'gp-dayhead' + (allSel ? ' all' : '') },
      h('button', { class: 'gp-daycheck', title: allSel ? 'Deselect day' : 'Select day', html: CHECK, onclick: () => { for (const i of g.items) allSel ? st.sel.delete(i.id) : st.sel.add(i.id); redraw(); } }),
      h('span', {}, dayLabel(g.date))));
    // justify: fill each row to the full width, scaling its height
    let row = [], sum = 0, rowsH = 0;
    const flush = last => {
      if (!row.length) return;
      const avail = width - GAP * (row.length - 1);
      const rh = last && sum * H < avail ? H : avail / sum;
      const r = h('div', { class: 'gp-row', style: { height: rh + 'px' } });
      for (const it of row) r.append(tile(serial, st, it, Math.floor(aspect(it) * rh), rh, order, redraw));
      sec.append(r); rowsH += rh + GAP; row = []; sum = 0;
    };
    for (const it of g.items) { row.push(it); sum += aspect(it); if (sum * H + GAP * (row.length - 1) >= width) flush(false); }
    flush(true);
    sec.style.containIntrinsicSize = `auto ${Math.round(rowsH + 44)}px`;
    body.append(sec);
  }
  $('#status').textContent = `${plural(shown.filter(i => i.kind === 'image').length, 'photo')}, ${plural(shown.filter(i => i.kind === 'video').length, 'video')}`;
}
const CHECK = '<svg width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" class="ring"/><path d="M7.5 12.3l3 3 6-6.3" class="tick"/></svg>';

function tile(serial, st, it, w, ht, order, redraw) {
  const sel = st.sel.has(it.id);
  const el = h('div', { class: 'gp-tile' + (sel ? ' sel' : '') + (st.sel.size ? ' selecting' : ''), style: { width: w + 'px', height: ht + 'px' }, title: it.path.split('/').pop() });
  const img = h('img', { loading: 'lazy', decoding: 'async', src: thumbUrl(serial, it.id), alt: '', draggable: 'false' });
  img.onerror = () => { el.classList.add('noimg'); img.remove(); el.prepend(h('div', { class: 'gp-ph', html: it.kind === 'video' ? I.play(28) : I.photos(28) })); };
  img.onload = () => { if (!it.w && img.naturalWidth) { it.w = img.naturalWidth; it.h = img.naturalHeight; relayoutSoon(); } };
  el.append(img);
  if (it.kind === 'video') el.append(h('div', { class: 'gp-dur' }, it.duration ? fmtTime(it.duration) : '', h('span', { html: I.play(11) })));
  const check = h('button', { class: 'gp-check', html: CHECK, title: sel ? 'Deselect' : 'Select' });
  el.append(check);
  const toggle = e => {
    if (e.shiftKey && st.anchor) {
      const a = order.findIndex(x => x.id === st.anchor), b = order.findIndex(x => x.id === it.id);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) st.sel.add(order[i].id);
    } else if (st.sel.has(it.id)) st.sel.delete(it.id); else st.sel.add(it.id);
    st.anchor = it.id; redraw();
  };
  check.onclick = e => { e.stopPropagation(); toggle(e); };
  el.onclick = e => { if (st.sel.size || e.ctrlKey || e.shiftKey) toggle(e); else openViewer(serial, order, order.indexOf(it)); };
  return el;
}
let relayT = 0;
function relayoutSoon() { clearTimeout(relayT); relayT = setTimeout(() => { if (/^device:[^:]+:photos$/.test(S.route)) { const sc = $('#view').scrollTop; render(); $('#view').scrollTop = sc; } }, 600); }

function albumGrid(v, serial, items) {
  const albums = new Map();
  for (const it of items) { const a = albums.get(it.album) || { name: it.album, items: [] }; a.items.push(it); albums.set(it.album, a); }
  const list = [...albums.values()].sort((a, b) => b.items[0].date - a.items[0].date);
  const grid = h('div', { class: 'gp-albums' });
  for (const a of list) {
    const cover = a.items.find(i => i.kind === 'image') || a.items[0];
    grid.append(h('div', { class: 'gp-album', onclick: () => { const st = phState(serial); st.album = a.name; st.tab = 'photos'; render(); } },
      h('div', { class: 'cv' }, h('img', { loading: 'lazy', src: thumbUrl(serial, cover.id), alt: '', onerror: e => e.target.remove() })),
      h('div', { class: 'nm' }, a.name || 'Unnamed'), h('div', { class: 'ct' }, plural(a.items.length, 'item'))));
  }
  v.append(grid);
  $('#status').textContent = plural(list.length, 'album');
}

// ---------------------------------------------------------------- viewer
function openViewer(serial, order, idx) {
  let i = idx, info = false;
  const ov = h('div', { class: 'gp-viewer' });
  const stage = h('div', { class: 'gp-stage' }), panel = h('aside', { class: 'gp-info' });
  const top = h('div', { class: 'gp-vtop' });
  const prevB = h('button', { class: 'gp-nav l', html: I.back(26), onclick: () => step(-1) }), nextB = h('button', { class: 'gp-nav r', html: I.fwd(26), onclick: () => step(1) });
  ov.append(h('div', { class: 'gp-main' }, top, stage, prevB, nextB), panel);
  document.body.append(ov);
  const close = () => { ov.remove(); document.removeEventListener('keydown', key, true); };
  const key = e => {
    if ($('.scrim')) return;
    const vid = stage.querySelector('video');
    if (e.key === 'Escape') { e.stopImmediatePropagation(); close(); }
    else if (e.key === 'ArrowLeft') { e.stopImmediatePropagation(); step(-1); }
    else if (e.key === 'ArrowRight') { e.stopImmediatePropagation(); step(1); }
    else if (e.key === 'Delete') { e.stopImmediatePropagation(); del(); }
    else if (e.key === ' ' && vid) { e.preventDefault(); e.stopImmediatePropagation(); vid.paused ? vid.play() : vid.pause(); }
    else if (e.key === 'i') { info = !info; show(); }
  };
  document.addEventListener('keydown', key, true);
  const del = () => deletePhotos(serial, [order[i].id], () => { order.splice(i, 1); if (!order.length) return close(); if (i >= order.length) i = order.length - 1; show(); });
  function step(n) { const j = i + n; if (j < 0 || j >= order.length) return; i = j; show(); }
  function show() {
    const it = order[i];
    prevB.hidden = i === 0; nextB.hidden = i === order.length - 1;
    top.innerHTML = '';
    top.append(h('button', { class: 'ibtn', title: 'Back (Esc)', html: I.back(20), onclick: close }), h('div', { class: 'grow' }),
      h('button', { class: 'ibtn' + (info ? ' on' : ''), title: 'Info (I)', html: I.info(20), onclick: () => { info = !info; show(); } }),
      h('button', { class: 'ibtn', title: 'Download', html: I.download(20), onclick: () => downloadPhotos(serial, [it.id]) }),
      h('button', { class: 'ibtn', title: 'Delete from phone (Delete)', html: I.trash(20), onclick: del }));
    stage.innerHTML = '';
    const spin = h('div', { class: 'gp-loading' }, h('div', { class: 'spinner' }), it.kind === 'video' ? `Loading video from the phone${it.size > 50e6 ? ` (${fmtBytes(it.size)})` : ''}…` : '');
    if (it.kind === 'video') {
      const vid = h('video', { controls: true, autoplay: true, src: fullUrl(serial, it.id) });
      vid.addEventListener('canplay', () => spin.remove());
      vid.addEventListener('error', () => { spin.remove(); stage.append(h('div', { class: 'gp-loading' }, 'This video can’t be played here. Download it to watch it.')); });
      stage.append(vid, spin);
    } else {
      const low = h('img', { class: 'low', src: thumbUrl(serial, it.id), alt: '' });
      const hi = h('img', { class: 'hi', alt: '' });
      hi.onload = () => { low.remove(); spin.remove(); hi.classList.add('ready'); };
      hi.onerror = () => spin.remove();
      stage.append(low, hi, spin);
      setTimeout(() => { if (order[i] === it) hi.src = fullUrl(serial, it.id); }, 80);
    }
    ov.classList.toggle('with-info', info);
    panel.innerHTML = '';
    if (info) {
      const d = new Date(it.date);
      const mp = it.w && it.h ? `${it.w} × ${it.h}${it.kind === 'image' ? ` · ${(it.w * it.h / 1e6).toFixed(1)} MP` : ''}` : '';
      panel.append(h('header', {}, h('button', { class: 'ibtn', html: I.close(16), onclick: () => { info = false; show(); } }), 'Info'),
        h('div', { class: 'gp-irow' }, h('span', { html: I.calendar(18) }), h('div', {}, h('b', {}, d.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'long', day: 'numeric' })), h('div', {}, d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })))),
        h('div', { class: 'gp-irow' }, h('span', { html: it.kind === 'video' ? I.play(18) : I.photos(18) }), h('div', {}, h('b', {}, it.path.split('/').pop()), h('div', {}, [mp, fmtBytes(it.size), it.duration ? fmtTime(it.duration) : ''].filter(Boolean).join(' · ')))),
        h('div', { class: 'gp-irow' }, h('span', { html: I.folder(18) }), h('div', {}, h('b', {}, it.album || ''), h('div', { class: 'path' }, it.path))));
    }
  }
  show();
}

// ---------------------------------------------------------------- actions
let dlBox = null;
async function downloadPhotos(serial, ids) {
  if (!ids.length) return;
  try {
    const r = await vk.phDownload(serial, ids);
    const st = phState(serial); st.sel.clear(); if (/photos$/.test(S.route)) render();
    if (dlBox) dlBox.remove();
    dlBox = h('div', { class: 'gp-toast' }, `Saved ${plural(r.files.length, 'item')} to ${r.dest.replace(/^\/home\/[^/]+/, '~')}`,
      h('button', { class: 'btn', onclick: () => vk.phOpenFolder(r.dest) }, 'Show in Folder'), h('button', { class: 'ibtn', html: I.close(13), onclick: () => dlBox.remove() }));
    document.body.append(dlBox);
    const b = dlBox; setTimeout(() => b.remove(), 9000);
  } catch (e) { toast('Download failed: ' + String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 6000); }
}
vk.on('ph:progress', p => {
  if (p.done) return;
  if (!dlBox || !dlBox.classList.contains('prog')) { if (dlBox) dlBox.remove(); dlBox = h('div', { class: 'gp-toast prog' }); document.body.append(dlBox); }
  dlBox.textContent = p.n > 1 ? `Downloading ${p.i} of ${p.n}…` : `Downloading ${p.name}…`;
});
function deletePhotos(serial, ids, after) {
  const st = phState(serial);
  const its = ids.map(id => st.items.find(x => x.id === id)).filter(Boolean);
  const nV = its.filter(x => x.kind === 'video').length, nI = its.length - nV;
  const what = [nI ? plural(nI, 'photo') : '', nV ? plural(nV, 'video') : ''].filter(Boolean).join(' and ');
  dialog(`Delete ${what} from the phone?`, h('div', {}, 'They’re deleted from the phone itself and can’t be restored from here. Download them first if you want to keep a copy.'),
    [{ label: 'Cancel' }, { label: 'Delete', danger: true, primary: true, fn: async () => {
      try {
        await vk.phRemove(serial, ids);
        const gone = new Set(ids);
        st.items = st.items.filter(x => !gone.has(x.id)); for (const id of ids) st.sel.delete(id);
        toast(`Deleted ${what}`);
        if (after) after(); if (/photos$/.test(S.route)) { const sc = $('#view').scrollTop; render(); $('#view').scrollTop = sc; }
      } catch (e) { toast('Delete failed: ' + (e.message || e), 6000); }
    } }]);
}

// Ctrl+A / Esc / Delete on the Photos page
document.addEventListener('keydown', e => {
  const m = /^device:([^:]+):photos$/.exec(S.route); if (!m || $('.gp-viewer') || $('.scrim') || /INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
  const st = phState(m[1]); if (!st.items) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault(); e.stopImmediatePropagation();
    const shown = st.tab === 'videos' ? st.items.filter(i => i.kind === 'video') : st.album != null ? st.items.filter(i => i.album === st.album) : st.items;
    for (const i of shown) st.sel.add(i.id); render();
  } else if (e.key === 'Escape' && st.sel.size) { e.stopImmediatePropagation(); st.sel.clear(); render(); }
  else if (e.key === 'Delete' && st.sel.size) { e.stopImmediatePropagation(); deletePhotos(m[1], [...st.sel]); }
}, true);
// relayout when the window is resized
new ResizeObserver(() => { if (/^device:[^:]+:photos$/.test(S.route) && !$('.gp-viewer')) relayoutSoon(); }).observe(document.getElementById('view'));
