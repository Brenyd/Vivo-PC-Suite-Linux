// Music library: scans folders, reads tags, keeps album artwork, playlists, play counts and ratings.
// Stored as JSON in ~/.config/pcsuite/music/library.json (artwork in ./art).
'use strict';
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os'), crypto = require('crypto'), cp = require('child_process');
const { readTags, AUDIO_EXT } = require('./tags.js');

const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'albumartsmall', 'artwork'];

class Library {
  constructor(dir, { nativeImage, log } = {}) {
    this.dir = dir; this.artDir = path.join(dir, 'art'); this.file = path.join(dir, 'library.json');
    this.nativeImage = nativeImage; this.log = log || (() => {});
    fs.mkdirSync(this.artDir, { recursive: true });
    this.db = { version: 1, folders: [], tracks: {}, playlists: [], devices: {}, settings: {} };
    try { Object.assign(this.db, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (_) {}
    if (!this.db.folders.length && !this.db.initialized) {
      const m = defaultMusicDir(); if (m) this.db.folders.push(m);
    }
    this.db.initialized = true;
    this.listeners = new Set(); this.scanning = null; this.saveT = null;
  }
  on(f) { this.listeners.add(f); }
  emit(ev, data) { for (const f of this.listeners) try { f(ev, data); } catch (_) {} }
  save(now) {
    clearTimeout(this.saveT);
    const doit = () => { try { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file); } catch (e) { this.log('library save: ' + e.message); } };
    if (now) doit(); else this.saveT = setTimeout(doit, 800);
  }
  snapshot() {
    return { folders: this.db.folders, tracks: Object.values(this.db.tracks), playlists: this.db.playlists, settings: this.db.settings, artDir: this.artDir };
  }

  // ------------------------------------------------------------ scanning
  async scan(extraPaths) {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const roots = extraPaths && extraPaths.length ? extraPaths : this.db.folders;
      const files = [];
      for (const r of roots) await walk(r, files);
      const seen = new Set(files);
      const changed = [];
      let done = 0;
      this.emit('scan', { done: 0, total: files.length });
      const queue = files.slice();
      const worker = async () => {
        while (queue.length) {
          const f = queue.shift();
          try {
            const st = await fsp.stat(f), id = sha(f).slice(0, 16), old = this.db.tracks[id];
            if (!old || old.size !== st.size || old.mtime !== Math.round(st.mtimeMs)) {
              const t = await this.readTrack(f, st, old);
              this.db.tracks[id] = t; changed.push(t);
              if (changed.length % 50 === 0) { this.emit('tracks', { upsert: changed.splice(0) }); this.save(); }
            }
          } catch (e) { this.log(`scan ${f}: ${e.message}`); }
          if (++done % 25 === 0) this.emit('scan', { done, total: files.length });
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      // drop tracks whose files are gone (only below the folders that were scanned)
      const removed = [];
      if (!extraPaths || !extraPaths.length) for (const t of Object.values(this.db.tracks)) {
        const under = roots.some(r => t.path.startsWith(r.endsWith('/') ? r : r + '/'));
        if ((under && !seen.has(t.path)) || (!under && !fs.existsSync(t.path))) { delete this.db.tracks[t.id]; removed.push(t.id); }
      }
      if (changed.length || removed.length) this.emit('tracks', { upsert: changed, removed });
      this.emit('scan', { done: files.length, total: files.length, finished: true });
      this.save();
      return { added: changed.length, removed: removed.length };
    })().finally(() => { this.scanning = null; });
    return this.scanning;
  }
  async readTrack(f, st, old) {
    const tg = await readTags(f);
    const base = path.basename(f, path.extname(f));
    const t = Object.assign({
      id: sha(f).slice(0, 16), path: f, size: st.size, mtime: Math.round(st.mtimeMs), added: Date.now(), plays: 0, skips: 0, lastPlayed: 0, rating: 0, loved: false,
    }, old ? { added: old.added, plays: old.plays, skips: old.skips, lastPlayed: old.lastPlayed, rating: old.rating, loved: old.loved } : {});
    Object.assign(t, {
      title: tg.title || base.replace(/^\d+[\s.\-_]+/, ''), artist: tg.artist, albumArtist: tg.albumArtist, album: tg.album, genre: tg.genre,
      composer: tg.composer, comment: tg.comment, year: tg.year, track: tg.track, trackTotal: tg.trackTotal, disc: tg.disc, discTotal: tg.discTotal,
      compilation: tg.compilation, duration: tg.duration, bitrate: tg.bitrate, sampleRate: tg.sampleRate, codec: tg.codec, kind: kindOf(f, tg.codec),
    });
    t.art = await this.storeArt(t, tg.picture, path.dirname(f));
    return t;
  }
  albumKey(t) { return t.album ? sha(((t.compilation ? 'Compilations' : (t.albumArtist || t.artist)) || '').toLowerCase() + '\0' + t.album.toLowerCase()).slice(0, 20) : 't' + t.id; }
  async storeArt(t, pic, dir) {
    const key = this.albumKey(t), out = path.join(this.artDir, key + '.jpg');
    if (fs.existsSync(out)) return key;
    let data = pic && pic.data;
    if (!data) data = await folderCover(dir);
    if (!data) return '';
    try {
      if (this.nativeImage) {
        let img = this.nativeImage.createFromBuffer(data);
        if (img.isEmpty()) return '';
        const { width } = img.getSize();
        if (width > 600) img = img.resize({ width: 600, quality: 'good' });
        data = img.toJPEG(88);
      }
      await fsp.writeFile(out, data);
      return key;
    } catch (_) { return ''; }
  }

  // ------------------------------------------------------------ edits
  update(ids, fields) {
    const out = [];
    for (const id of ids) { const t = this.db.tracks[id]; if (!t) continue; Object.assign(t, fields); out.push(t); }
    if (out.length) { this.emit('tracks', { upsert: out }); this.save(); }
    return out;
  }
  played(id) { const t = this.db.tracks[id]; if (t) { t.plays = (t.plays || 0) + 1; t.lastPlayed = Date.now(); this.emit('tracks', { upsert: [t] }); this.save(); } }
  skipped(id) { const t = this.db.tracks[id]; if (t) { t.skips = (t.skips || 0) + 1; this.save(); } }
  async editTags(ids, fields, writeFiles) {
    const res = { written: 0, failed: [] };
    for (const id of ids) {
      const t = this.db.tracks[id]; if (!t) continue;
      Object.assign(t, fields);
      if (writeFiles) {
        try { await writeTagsToFile(t.path, fields); const st = fs.statSync(t.path); t.size = st.size; t.mtime = Math.round(st.mtimeMs); res.written++; }
        catch (e) { res.failed.push(path.basename(t.path) + ': ' + e.message); }
      }
      if ('album' in fields || 'albumArtist' in fields || 'artist' in fields) {
        const old = t.art; t.art = this.albumKey(t);
        if (old && old !== t.art && !fs.existsSync(path.join(this.artDir, t.art + '.jpg'))) try { fs.copyFileSync(path.join(this.artDir, old + '.jpg'), path.join(this.artDir, t.art + '.jpg')); } catch (_) { t.art = old; }
      }
    }
    this.emit('tracks', { upsert: ids.map(i => this.db.tracks[i]).filter(Boolean) });
    this.save();
    return res;
  }
  async setArtwork(ids, file) {
    const data = await fsp.readFile(file);
    const keys = new Set();
    for (const id of ids) { const t = this.db.tracks[id]; if (t) keys.add(this.albumKey(t)); }
    for (const k of keys) { try { fs.unlinkSync(path.join(this.artDir, k + '.jpg')); } catch (_) {} }
    for (const id of ids) { const t = this.db.tracks[id]; if (t) { t.art = await this.storeArt(t, { data }, ''); t.artRev = Date.now(); } }
    this.emit('tracks', { upsert: ids.map(i => this.db.tracks[i]).filter(Boolean) });
    this.save();
  }
  remove(ids) {
    for (const id of ids) delete this.db.tracks[id];
    for (const p of this.db.playlists) if (p.items) p.items = p.items.filter(i => !ids.includes(i));
    this.emit('tracks', { removed: ids }); this.save();
  }
  addFolder(dir) { if (!this.db.folders.includes(dir)) { this.db.folders.push(dir); this.save(); } return this.scan(); }
  removeFolder(dir) { this.db.folders = this.db.folders.filter(f => f !== dir); this.save(); return this.scan(); }
  setPlaylists(pl) { this.db.playlists = pl; this.save(); }
  setSettings(s) { Object.assign(this.db.settings, s); this.save(); return this.db.settings; }
  device(serial) { return (this.db.devices[serial] = this.db.devices[serial] || { sync: false, mode: 'all', playlists: [], artists: [], albums: [], genres: [], auto: false, convert: false, m3u: true }); }
  setDevice(serial, d) { Object.assign(this.device(serial), d); this.save(); return this.device(serial); }
  track(id) { return this.db.tracks[id]; }
  tracks() { return Object.values(this.db.tracks); }
}

function kindOf(f, codec) {
  const e = path.extname(f).slice(1).toUpperCase();
  const MAP = { aac: 'AAC audio file', alac: 'Apple Lossless audio file', mp3: 'MPEG audio file', flac: 'FLAC audio file', vorbis: 'Ogg Vorbis audio file', opus: 'Opus audio file', pcm: 'WAV audio file' };
  return MAP[codec] || `${e} audio file`;
}
async function walk(dir, out, depth = 0) {
  if (depth > 12) return;
  if (depth === 0) { try { const st = await fsp.stat(dir); if (st.isFile()) { if (AUDIO_EXT.has(path.extname(dir).toLowerCase())) out.push(dir); return; } } catch (_) { return; } }
  let ents; try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, depth + 1);
    else if ((e.isFile() || e.isSymbolicLink()) && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}
async function folderCover(dir) {
  if (!dir) return null;
  let ents; try { ents = await fsp.readdir(dir); } catch (_) { return null; }
  const imgs = ents.filter(n => /\.(jpe?g|png|webp)$/i.test(n));
  const pick = imgs.find(n => COVER_NAMES.includes(n.toLowerCase().replace(/\.[^.]+$/, '').replace(/[\s_{}-]/g, '').replace(/^albumart.*/, 'albumart'))) || (imgs.length === 1 ? imgs[0] : null);
  if (!pick) return null;
  try { return await fsp.readFile(path.join(dir, pick)); } catch (_) { return null; }
}
function defaultMusicDir() {
  try { const d = cp.execFileSync('xdg-user-dir', ['MUSIC'], { encoding: 'utf8', timeout: 3000 }).trim(); if (d && d !== os.homedir() && fs.existsSync(d)) return d; } catch (_) {}
  const d = path.join(os.homedir(), 'Music');
  return fs.existsSync(d) ? d : null;
}
const FF_KEYS = { title: 'title', artist: 'artist', albumArtist: 'album_artist', album: 'album', genre: 'genre', year: 'date', composer: 'composer', comment: 'comment' };
function writeTagsToFile(file, fields) {
  return new Promise((res, rej) => {
    const ext = path.extname(file), tmp = path.join(path.dirname(file), `.${path.basename(file, ext)}.vk-tmp${ext}`);
    const args = ['-v', 'error', '-y', '-i', file, '-map', '0', '-c', 'copy', '-map_metadata', '0'];
    for (const [k, v] of Object.entries(fields)) {
      if (FF_KEYS[k]) args.push('-metadata', `${FF_KEYS[k]}=${v || ''}`);
      else if (k === 'track') args.push('-metadata', `track=${v ? v + (fields.trackTotal ? '/' + fields.trackTotal : '') : ''}`);
      else if (k === 'disc') args.push('-metadata', `disc=${v ? v + (fields.discTotal ? '/' + fields.discTotal : '') : ''}`);
    }
    if (ext.toLowerCase() === '.mp3') args.push('-id3v2_version', '3', '-write_id3v1', '1');
    if (/\.(m4a|mp4|m4b)$/i.test(ext)) args.push('-disposition:v', 'attached_pic');
    args.push(tmp);
    cp.execFile('ffmpeg', args, { timeout: 120000 }, (e, _o, err) => {
      if (e) { try { fs.unlinkSync(tmp); } catch (_) {} return rej(new Error(e.code === 'ENOENT' ? 'ffmpeg is not installed' : String(err || e.message).trim().split('\n').pop())); }
      try { fs.renameSync(tmp, file); res(); } catch (x) { rej(x); }
    });
  });
}

module.exports = { Library, writeTagsToFile, defaultMusicDir };
