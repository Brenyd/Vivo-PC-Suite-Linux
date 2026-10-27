// Phone side of the music app, over adb: device detection, summary (model, storage, battery),
// iTunes-style music sync, and browsing / importing / deleting music that's on the phone.
//
// Sync only ever touches files it put on the phone itself. It keeps a manifest at
// /sdcard/Music/.vivo-officekit-sync.json; music you copied to the phone another way is never deleted.
'use strict';
const cp = require('child_process'), fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os'), crypto = require('crypto');

const ADB = () => process.env.PCSUITE_ADB || 'adb';
const MUSIC_ROOT = '/sdcard/Music';
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
        const du = await sh(serial, 'du -sk /sdcard/Music /sdcard/DCIM /sdcard/Pictures /sdcard/Movies /sdcard/Download /sdcard/Documents 2>/dev/null', { timeout: 45000 });
        const u = {}; for (const l of du.trim().split('\n')) { const [k, p] = l.split(/\s+/); if (p) u[p.replace('/sdcard/', '')] = +k * 1024; }
        info.usage = { audio: u.Music || 0, photos: (u.DCIM || 0) + (u.Pictures || 0), video: u.Movies || 0, documents: (u.Download || 0) + (u.Documents || 0) };
      } catch (_) {}
    }
    this.emit('devices', { list: this.publicList() });
    return info;
  }

  // ------------------------------------------------------------ music on the phone
  async phoneMusic(serial) {
    const out = await sh(serial, `find /sdcard -path /sdcard/Android -prune -o -type f -size +40k \\( ${['mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wav', 'wma', 'amr', 'ape', 'm4b'].map(e => `-iname '*.${e}'`).join(' -o ')} \\) -exec stat -c '%s %Y %n' {} + 2>/dev/null`, { timeout: 120000 });
    const manifest = await this.readManifest(serial);
    return out.split('\n').map(l => l.match(/^(\d+) (\d+) (.+)$/)).filter(Boolean).map(m => {
      const p = m[3], own = manifest.files[p];
      const name = path.basename(p).replace(/\.[^.]+$/, '');
      const parts = p.split('/');
      return { path: p, size: +m[1], mtime: +m[2] * 1000, title: own ? own.title : name.replace(/^\d+[\s.\-_]+/, ''), artist: own ? own.artist : (parts.length > 5 && p.startsWith(MUSIC_ROOT) ? parts[parts.length - 3] : ''), album: own ? own.album : '', synced: !!own };
    }).filter(f => !/\/(Recordings?|Record|Sounds|Notifications|Ringtones|Alarms|Call)\b/i.test(f.path) || f.size > 2e6);
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
      const rel = p.startsWith(MUSIC_ROOT + '/') ? p.slice(MUSIC_ROOT.length + 1) : p.replace(/^\/sdcard\/?/, '');
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
    try { const j = JSON.parse(await adb(serial, ['exec-out', `cat ${q(MANIFEST)} 2>/dev/null`], { timeout: 20000 })); if (j && j.files) return Object.assign({ playlists: [] }, j); } catch (_) {}
    return { version: 1, files: {}, playlists: [] };
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
        const out = await sh(serial, `find ${q(MUSIC_ROOT)} -type f -exec stat -c '%s %n' {} + 2>/dev/null`, { timeout: 120000 });
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

module.exports = { Devices, albumId, MUSIC_ROOT };
