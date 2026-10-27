// Phone side of the music app, over adb: device detection, summary (model, storage, battery),
// iTunes-style music sync, and browsing / importing / deleting music that's on the phone.
//
// Sync only ever touches files it put on the phone itself. It keeps a manifest at
// /storage/emulated/0/Music/.vivo-officekit-sync.json; music you copied to the phone another way is never deleted.
'use strict';
const cp = require('child_process'), fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os'), crypto = require('crypto');

const ADB = () => process.env.PCSUITE_ADB || 'adb';
// The phone's internal storage. /sdcard points here too, but it's a symlink, so the real path is used everywhere.
const STORAGE = '/storage/emulated/0';
const MUSIC_ROOT = STORAGE + '/Music';
const MANIFEST = MUSIC_ROOT + '/.vivo-officekit-sync.json';
const PLAYLIST_DIR = MUSIC_ROOT + '/Playlists';
const AUDIO_RE = /\.(mp3|m4a|aac|flac|ogg|oga|opus|wav|wma|amr|mid|midi|ape|m4b)$/i;
const LOSSLESS = new Set(['flac', 'alac', 'pcm', 'aiff', 'wav', 'ape', 'wavpack']);

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
function adb(serial, args, { timeout = 30000, encoding = 'utf8', maxBuffer = 64 << 20 } = {}) {
  return new Promise((res, rej) => {
    cp.execFile(ADB(), serial ? ['-s', serial, ...args] : args, { timeout, encoding, maxBuffer }, (e, out, err) => {
      if (e) { e.message = String(err || e.message).trim() || e.message; return rej(e); }
      res(out);
    });
  });
}
const sh = (serial, cmd, o) => adb(serial, ['shell', cmd], o);
const clean = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80) || '_';

const clean0 = v => (v == null || v === 'NULL' || v === '<unknown>') ? '' : String(v);
/** /sdcard/x, /storage/self/primary/x -> /storage/emulated/0/x (the one path the app and the sync list use) */
const phonePath = p => String(p).replace(/^\/(sdcard|storage\/self\/primary|mnt\/sdcard)(?=\/|$)/, STORAGE);
/** `content query` on the phone. Returns rows as objects, or null when the media index can't be read.
 *  Values may contain ", " so each row is split at the known ", key=" markers, in projection order. */
async function contentQuery(serial, uri, keys, where) {
  let out;
  try { out = await sh(serial, `content query --uri ${uri} --projection ${keys.join(':')}${where ? ` --where ${q(where)}` : ''}`, { timeout: 120000, maxBuffer: 256 << 20 }); }
  catch (_) { return null; }
  if (!/^Row: /m.test(out)) return /No result found/i.test(out) ? [] : null;
  const rows = [];
  for (const line of out.split(/\r?\n(?=Row: \d+ )/)) {
    const m = line.match(/^Row: \d+ ([\s\S]*)$/); if (!m) continue;
    const body = m[1].replace(/\r?\n$/, ''), r = {};
    let pos = 0;
    for (let i = 0; i < keys.length; i++) {
      const start = i === 0 ? body.indexOf(keys[0] + '=') : body.indexOf(', ' + keys[i] + '=', pos);
      if (start < 0) continue;
      const vs = start + (i === 0 ? 0 : 2) + keys[i].length + 1;
      let end = body.length;
      for (let j = i + 1; j < keys.length; j++) { const e = body.indexOf(', ' + keys[j] + '=', vs); if (e >= 0) { end = e; break; } }
      r[keys[i]] = body.slice(vs, end); pos = end;
    }
    rows.push(r);
  }
  return rows;
}
/** Files under `base` with the given extensions -> [{ path, size, mtime }]. `find` runs from inside the folder,
 *  so it works even when the folder is reached through a symlink (find doesn't descend into one given as its start). */
// `; true`: find exits non-zero when it meets a folder it may not read, and adb passes that on as a failure.
async function findFiles(serial, exts, extra = '', dirs = '.', base = STORAGE) {
  const names = exts.map(e => `-iname '*.${e}'`).join(' -o ');
  const out = await sh(serial, `cd ${q(base + '/')} && find ${dirs} -path ./Android -prune -o -type f ${extra} \\( ${names} \\) -exec stat -c '%s %Y %n' {} + 2>/dev/null; true`, { timeout: 180000, maxBuffer: 256 << 20 });
  return out.split('\n').map(l => l.match(/^(\d+) (\d+) (.+)$/)).filter(Boolean)
    .map(m => ({ path: base + '/' + m[3].replace(/^\.\//, ''), size: +m[1], mtime: +m[2] * 1000 }));
}

class Devices {
  constructor(library, { log, cacheDir } = {}) {
    this.lib = library; this.log = log || (() => {});
    this.cacheDir = cacheDir || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'vivo-pcsuite-linux', 'transcode');
    this.list = []; this.info = {}; this.listeners = new Set(); this.timer = null; this.sync = null; this.adbMissing = false;
  }
  on(f) { this.listeners.add(f); }
  emit(ev, d) { for (const f of this.listeners) try { f(ev, d); } catch (_) {} }

  start() {
    const tick = async () => {
      let out = '';
      try { out = await adb(null, ['devices', '-l'], { timeout: 8000 }); this.adbMissing = false; }
      catch (e) { if (e.code === 'ENOENT' && !this.adbMissing) { this.adbMissing = true; this.emit('devices', { list: [], adbMissing: true }); } }
      const list = out.split('\n').slice(1).map(l => l.trim()).filter(Boolean).map(l => {
        const [serial, state, ...rest] = l.split(/\s+/);
        const kv = Object.fromEntries(rest.map(x => x.split(':')).filter(x => x.length === 2));
        return { serial, state, model: (kv.model || '').replace(/_/g, ' '), usb: !serial.includes(':') };
      }).filter(d => d.state !== 'offline');
      const key = JSON.stringify(list.map(d => d.serial + d.state));
      if (key !== this.key) {
        const before = new Set(this.list.filter(d => d.state === 'device').map(d => d.serial));
        this.key = key; this.list = list;
        this.emit('devices', { list: this.publicList() });
        for (const d of list) if (d.state === 'device' && !before.has(d.serial)) this.connected(d.serial);
      }
    };
    tick(); this.timer = setInterval(tick, 2500);
  }
  publicList() { return this.list.map(d => Object.assign({}, d, this.info[d.serial] || {}, { settings: this.lib.device(d.serial) })); }
  async connected(serial) {
    try { await this.refreshInfo(serial); } catch (e) { this.log('device info: ' + e.message); }
    const s = this.lib.device(serial);
    if (s.sync && s.auto) setTimeout(() => { if (!this.sync && this.isReady(serial)) this.startSync(serial).catch(() => {}); }, 4000);
  }
  isReady(serial) { return this.list.some(d => d.serial === serial && d.state === 'device'); }

  async refreshInfo(serial, withUsage = false) {
    const props = {};
    const out = await sh(serial, 'getprop', { timeout: 10000 });
    for (const m of out.matchAll(/^\[([^\]]+)\]: \[(.*)\]$/gm)) props[m[1]] = m[2];
    const info = this.info[serial] = Object.assign(this.info[serial] || {}, {
      name: props['ro.vivo.market.name'] || props['ro.product.marketname'] || props['ro.product.model'] || serial,
      model: props['ro.product.model'] || '', brand: props['ro.product.brand'] || '',
      android: props['ro.build.version.release'] || '', sdk: +props['ro.build.version.sdk'] || 0,
      os: props['ro.vivo.os.build.display.id'] || props['ro.vivo.os.version'] || props['ro.build.display.id'] || '',
      serialNo: props['ro.serialno'] || serial,
    });
    try { const b = await sh(serial, 'dumpsys battery', { timeout: 6000 }); const l = b.match(/level: (\d+)/), c = b.match(/(AC|USB) powered: true/); info.battery = l ? +l[1] : null; info.charging = !!c; } catch (_) {}
    try {
      const df = await sh(serial, 'df -k /data', { timeout: 8000 });
      const row = df.trim().split('\n').pop().trim().split(/\s+/);
      info.capacity = +row[1] * 1024; info.used = +row[2] * 1024; info.free = +row[3] * 1024;
    } catch (_) {}
    if (withUsage) {
      try {
        const du = await sh(serial, `cd ${STORAGE} && du -sk Music DCIM Pictures Movies Download Documents 2>/dev/null; true`, { timeout: 45000 });
        const u = {}; for (const l of du.trim().split('\n')) { const [k, p] = l.split(/\s+/); if (p) u[p.replace(/^\.?\//, '')] = +k * 1024; }
        info.usage = { audio: u.Music || 0, photos: (u.DCIM || 0) + (u.Pictures || 0), video: u.Movies || 0, documents: (u.Download || 0) + (u.Documents || 0) };
      } catch (_) {}
    }
    this.emit('devices', { list: this.publicList() });
    return info;
  }

  // ------------------------------------------------------------ music on the phone
  async phoneMusic(serial) {
    const manifest = await this.readManifest(serial);
    // Android's media index has the real tags; fall back to listing files if it can't be read
    let rows = await contentQuery(serial, 'content://media/external/audio/media', ['_data', 'title', 'artist', 'album', 'duration', '_size', 'date_modified', 'is_music']);
    let files;
    if (rows && rows.length) {
      // only the phone's Music folder: that's what sync writes to and what "On My Phone" shows
      files = rows.filter(r => r._data && phonePath(r._data).startsWith(MUSIC_ROOT + '/') && !/\/Playlists\/[^/]+\.m3u8?$/i.test(r._data)).map(r => ({
        path: phonePath(r._data), size: +r._size || 0, mtime: (+r.date_modified || 0) * 1000, duration: (+r.duration || 0) / 1000,
        title: clean0(r.title), artist: clean0(r.artist), album: clean0(r.album),
      }));
    } else {
      const out = await findFiles(serial, ['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'wma', 'amr', 'ape', 'm4b'], '', '.', MUSIC_ROOT);
      files = out.map(f => {
        const name = path.basename(f.path).replace(/\.[^.]+$/, ''), parts = f.path.split('/');
        return Object.assign(f, { title: name.replace(/^\d+[\s.\-_]+/, ''), artist: parts.length > 5 && f.path.startsWith(MUSIC_ROOT) ? parts[parts.length - 3] : '', album: '' });
      });
    }
    for (const f of files) {
      const own = manifest.files[f.path];
      if (own) Object.assign(f, { title: own.title || f.title, artist: own.artist || f.artist, album: own.album || f.album });
      f.synced = !!own;
    }
    return files;
  }
  async deleteFromPhone(serial, paths) {
    const manifest = await this.readManifest(serial);
    for (let i = 0; i < paths.length; i += 40) await sh(serial, 'rm -f ' + paths.slice(i, i + 40).map(q).join(' '), { timeout: 60000 });
    for (const p of paths) delete manifest.files[p];
    await this.writeManifest(serial, manifest);
    await this.mediaScan(serial, paths);
    return paths.length;
  }
  async importFromPhone(serial, items, destRoot, progress = () => {}) {
    const info = this.info[serial] || {};
    const dest = path.join(destRoot, clean(`From ${info.name || 'phone'}`));
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      const rel = p.startsWith(MUSIC_ROOT + '/') ? p.slice(MUSIC_ROOT.length + 1) : p.replace(STORAGE + '/', '');
      const local = path.join(dest, ...rel.split('/').map(clean));
      progress({ step: 'Importing', i: i + 1, n: items.length, title: path.basename(p) });
      if (fs.existsSync(local)) { out.push(local); continue; }
      await fsp.mkdir(path.dirname(local), { recursive: true });
      await adb(serial, ['pull', '-a', p, local], { timeout: 600000 });
      out.push(local);
    }
    return { dest, files: out };
  }
  async pullTemp(serial, p) {
    const dir = path.join(this.cacheDir, '..', 'phone-preview'); await fsp.mkdir(dir, { recursive: true });
    const local = path.join(dir, crypto.createHash('sha1').update(serial + p).digest('hex').slice(0, 16) + path.extname(p));
    if (!fs.existsSync(local)) await adb(serial, ['pull', p, local], { timeout: 300000 });
    return local;
  }

  // ------------------------------------------------------------ sync
  async readManifest(serial) {
    let j = null;
    for (const f of [MANIFEST, '/sdcard/Music/.vivo-officekit-sync.json']) {
      try { j = JSON.parse(await adb(serial, ['exec-out', `cat ${q(f)} 2>/dev/null`], { timeout: 20000 })); if (j && j.files) break; } catch (_) { j = null; }
    }
    if (!j || !j.files) return { version: 1, files: {}, playlists: [] };
    // lists written by the first version used /sdcard/... paths: same files, so convert instead of copying again
    const files = {}; for (const [k, v] of Object.entries(j.files)) files[phonePath(k)] = v;
    return Object.assign({ playlists: [] }, j, { files, playlists: (j.playlists || []).map(phonePath) });
  }
  async writeManifest(serial, m) {
    const tmp = path.join(os.tmpdir(), `vk-manifest-${process.pid}.json`);
    m.updated = Date.now(); m.host = os.hostname();
    await fsp.writeFile(tmp, JSON.stringify(m));
    try { await adb(serial, ['push', tmp, MANIFEST], { timeout: 30000 }); } finally { fsp.unlink(tmp).catch(() => {}); }
  }
  async mediaScan(serial, paths) {
    for (let i = 0; i < paths.length; i += 25) {
      const cmd = paths.slice(i, i + 25).map(p => `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${q('file://' + p)} >/dev/null 2>&1`).join('; ');
      try { await sh(serial, cmd, { timeout: 60000 }); } catch (_) {}
    }
  }
  /** Which library tracks should be on this phone, per its sync settings. */
  selection(serial, playlistsResolved) {
    const s = this.lib.device(serial), all = this.lib.tracks();
    if (!s.sync) return [];
    if (s.mode === 'all') return all;
    const ids = new Set();
    const pls = playlistsResolved || {};
    for (const pid of s.playlists || []) for (const id of pls[pid] || []) ids.add(id);
    const ar = new Set(s.artists || []), al = new Set(s.albums || []), ge = new Set(s.genres || []);
    for (const t of all) {
      const artist = t.albumArtist || t.artist || 'Unknown Artist';
      if (ar.has(artist) || ar.has(t.artist) || al.has(albumId(t)) || ge.has(t.genre || 'Unknown Genre')) ids.add(t.id);
    }
    return all.filter(t => ids.has(t.id));
  }
  phonePath(t, convert) {
    const artist = clean(t.compilation ? 'Compilations' : (t.albumArtist || t.artist || 'Unknown Artist'));
    const album = clean(t.album || 'Unknown Album');
    const num = t.track ? (t.discTotal > 1 && t.disc ? `${t.disc}-` : '') + String(t.track).padStart(2, '0') + ' ' : '';
    const ext = convert ? '.m4a' : path.extname(t.path).toLowerCase();
    return `${MUSIC_ROOT}/${artist}/${album}/${clean(num + (t.title || path.basename(t.path, path.extname(t.path))))}${ext}`;
  }
  needsConvert(t, s) { return !!s.convert && (LOSSLESS.has(t.codec) || (t.bitrate || 0) > 320 || /\.(wma|ape|wv|aiff?)$/i.test(t.path)); }
  plan(serial, playlistsResolved) {
    const s = this.lib.device(serial);
    const tracks = this.selection(serial, playlistsResolved);
    const files = tracks.map(t => { const conv = this.needsConvert(t, s); return { t, conv, dst: this.phonePath(t, conv), size: conv ? Math.round((t.duration || 0) * 256000 / 8) + 60000 : t.size }; });
    // de-duplicate identical destinations
    const seen = new Map();
    for (const f of files) { let d = f.dst, i = 2; while (seen.has(d) && seen.get(d) !== f.t.id) d = f.dst.replace(/(\.[^.]+)$/, ` ${i++}$1`); f.dst = d; seen.set(d, f.t.id); }
    return { files, bytes: files.reduce((a, f) => a + f.size, 0), count: files.length };
  }

  cancelSync() { if (this.sync) { this.sync.cancelled = true; if (this.sync.proc) try { this.sync.proc.kill(); } catch (_) {} } }
  async startSync(serial, playlistsResolved, playlistDefs) {
    if (this.sync) throw new Error('A sync is already running');
    const job = this.sync = { serial, cancelled: false, proc: null };
    const info = this.info[serial] || {};
    const p = d => this.emit('sync', Object.assign({ serial, name: info.name || serial }, d));
    const stopIfCancelled = () => { if (job.cancelled) throw new Error('Sync cancelled'); };
    const pushed = [], removed = [];
    let manifest = null;
    try {
      const s = this.lib.device(serial);
      p({ step: 1, steps: 5, label: 'Preparing to sync' });
      const plan = this.plan(serial, playlistsResolved);
      manifest = await this.readManifest(serial);
      // what's actually on the phone under Music (sizes), so files deleted on the phone get copied again
      let onPhone = {};
      try {
        const out = await sh(serial, `find ${q(MUSIC_ROOT)} -type f -exec stat -c '%s %n' {} + 2>/dev/null; true`, { timeout: 120000 });
        for (const l of out.split('\n')) { const m = l.match(/^(\d+) (.+)$/); if (m) onPhone[m[2]] = +m[1]; }
      } catch (_) {}
      stopIfCancelled();

      const want = new Map(plan.files.map(f => [f.dst, f]));
      const toCopy = plan.files.filter(f => {
        const m = manifest.files[f.dst];
        return !(m && m.id === f.t.id && m.srcMtime === f.t.mtime && m.srcSize === f.t.size && onPhone[f.dst] === m.size);
      });
      const toRemove = Object.keys(manifest.files).filter(d => !want.has(d));
      // space check
      const freeNeeded = toCopy.reduce((a, f) => a + f.size, 0) - toRemove.reduce((a, d) => a + (manifest.files[d].size || 0), 0);
      if (info.free != null && freeNeeded > info.free - 300e6) throw new Error(`Not enough space on the phone: needs ${gb(freeNeeded)}, ${gb(Math.max(0, info.free - 300e6))} available`);

      p({ step: 2, steps: 5, label: 'Removing songs', i: 0, n: toRemove.length });
      for (let i = 0; i < toRemove.length; i += 40) {
        stopIfCancelled();
        const chunk = toRemove.slice(i, i + 40);
        await sh(serial, 'rm -f ' + chunk.map(q).join(' '), { timeout: 60000 });
        for (const d of chunk) { delete manifest.files[d]; removed.push(d); }
        p({ step: 2, steps: 5, label: 'Removing songs', i: Math.min(i + 40, toRemove.length), n: toRemove.length });
      }
      if (removed.length) {
        const dirs = [...new Set(removed.map(d => path.posix.dirname(d)))];
        const parents = [...new Set(dirs.map(d => path.posix.dirname(d)))].filter(d => d !== MUSIC_ROOT && d.startsWith(MUSIC_ROOT));
        await sh(serial, `rmdir ${dirs.concat(parents).map(q).join(' ')} 2>/dev/null; true`, { timeout: 30000 }).catch(() => {});
      }

      const total = toCopy.reduce((a, f) => a + f.size, 0); let doneBytes = 0;
      for (let i = 0; i < toCopy.length; i++) {
        stopIfCancelled();
        const f = toCopy[i];
        p({ step: 3, steps: 5, label: `Copying ${i + 1} of ${toCopy.length}`, title: f.t.title, artist: f.t.artist, i, n: toCopy.length, bytes: doneBytes, total });
        let src = f.t.path;
        if (f.conv) { p({ step: 3, steps: 5, label: `Converting ${i + 1} of ${toCopy.length}`, title: f.t.title, artist: f.t.artist, i, n: toCopy.length, bytes: doneBytes, total }); src = await this.transcode(f.t, job); }
        stopIfCancelled();
        if (!fs.existsSync(src)) { this.log('sync: missing ' + src); continue; }
        const size = fs.statSync(src).size;
        await new Promise((res, rej) => {
          const pr = job.proc = cp.spawn(ADB(), ['-s', serial, 'push', src, f.dst], { stdio: ['ignore', 'pipe', 'pipe'] });
          let err = '';
          pr.stdout.on('data', () => {});
          pr.stderr.on('data', d => { err += d; });
          pr.on('error', rej);
          pr.on('exit', c => { job.proc = null; c === 0 ? res() : rej(new Error(err.trim().split('\n').pop() || 'adb push failed')); });
        });
        doneBytes += size;
        manifest.files[f.dst] = { id: f.t.id, size, srcSize: f.t.size, srcMtime: f.t.mtime, title: f.t.title, artist: f.t.artist, album: f.t.album, converted: f.conv };
        pushed.push(f.dst);
        if (i % 20 === 19) await this.writeManifest(serial, manifest);   // resumable
      }

      p({ step: 4, steps: 5, label: 'Updating playlists' });
      const oldPl = new Set(manifest.playlists || []); const newPl = [];
      if (s.sync && s.m3u && playlistDefs) {
        for (const pl of playlistDefs) {
          const lines = ['#EXTM3U'];
          for (const id of pl.items) {
            const f = plan.files.find(x => x.t.id === id); if (!f || !manifest.files[f.dst]) continue;
            lines.push(`#EXTINF:${Math.round(f.t.duration || 0)},${f.t.artist ? f.t.artist + ' - ' : ''}${f.t.title}`, '../' + path.posix.relative(MUSIC_ROOT, f.dst));
          }
          if (lines.length < 2) continue;
          const dst = `${PLAYLIST_DIR}/${clean(pl.name)}.m3u8`;
          const tmp = path.join(os.tmpdir(), `vk-pl-${process.pid}.m3u8`);
          await fsp.writeFile(tmp, lines.join('\n') + '\n');
          await adb(serial, ['push', tmp, dst], { timeout: 30000 }); fsp.unlink(tmp).catch(() => {});
          newPl.push(dst); pushed.push(dst);
        }
      }
      const stalePl = [...oldPl].filter(x => !newPl.includes(x));
      if (stalePl.length) { await sh(serial, 'rm -f ' + stalePl.map(q).join(' '), { timeout: 30000 }).catch(() => {}); removed.push(...stalePl); }
      manifest.playlists = newPl;

      p({ step: 5, steps: 5, label: 'Finishing sync' });
      await this.writeManifest(serial, manifest);
      await this.mediaScan(serial, pushed.concat(removed));
      this.lib.setDevice(serial, { lastSync: Date.now() });
      this.refreshInfo(serial).catch(() => {});
      p({ done: true, label: 'Sync complete', copied: pushed.length, removed: removed.length });
      return { copied: pushed.length, removed: removed.length };
    } catch (e) {
      // keep what was copied so the next sync continues where this one stopped
      try { if (manifest && (pushed.length || removed.length)) await this.writeManifest(serial, manifest); } catch (_) {}
      p({ done: true, error: e.message, label: job.cancelled ? 'Sync cancelled' : 'Sync failed' });
      throw e;
    } finally { this.sync = null; }
  }
  transcode(t, job) {
    const out = path.join(this.cacheDir, `${t.id}-${t.mtime}.m4a`);
    if (fs.existsSync(out)) return Promise.resolve(out);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const tmp = out + '.part.m4a';
    return new Promise((res, rej) => {
      const pr = job.proc = cp.spawn('ffmpeg', ['-v', 'error', '-y', '-i', t.path, '-map', '0:a:0', '-map', '0:v:0?', '-c:v', 'copy', '-disposition:v', 'attached_pic',
        '-c:a', 'aac', '-b:a', '256k', '-map_metadata', '0', '-movflags', '+faststart', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; pr.stderr.on('data', d => { err += d; });
      pr.on('error', e => rej(e.code === 'ENOENT' ? new Error('Converting songs needs ffmpeg: sudo pacman -S ffmpeg') : e));
      pr.on('exit', c => { job.proc = null; if (c === 0) { fs.renameSync(tmp, out); res(out); } else { try { fs.unlinkSync(tmp); } catch (_) {} rej(new Error('ffmpeg: ' + (err.trim().split('\n').pop() || 'conversion failed'))); } });
    });
  }
}
const gb = n => (n / 1e9).toFixed(2) + ' GB';
function albumId(t) { return ((t.compilation ? 'Compilations' : (t.albumArtist || t.artist)) || '') + '\u0001' + (t.album || ''); }

module.exports = { Devices, albumId, MUSIC_ROOT, contentQuery, findFiles, phonePath, adb, sh };
