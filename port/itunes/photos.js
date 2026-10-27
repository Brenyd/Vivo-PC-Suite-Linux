// Photos and videos on the phone, for the Photos page (a Google Photos-style timeline).
//   list()     -> every photo/video from Android's media index (date taken, size, dimensions, album), or from a
//                 file listing when the index can't be read
//   thumb()    -> small JPEG, made on the PC and cached in ~/.cache/vivo-pcsuite-linux/thumbs
//   full()     -> the original file, pulled on demand into a size-capped cache (for the viewer and video playback)
//   download() -> copies to the PC, keeping the file dates; remove() deletes from the phone
'use strict';
const fs = require('fs'), fsp = fs.promises, path = require('path'), os = require('os'), crypto = require('crypto'), cp = require('child_process');
const { contentQuery, findFiles, phonePath, adb, sh } = require('./device.js');

const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'vivo-pcsuite-linux');
const THUMBS = path.join(CACHE, 'thumbs'), FULL = path.join(CACHE, 'phone-media');
const FULL_CAP = 4e9;                       // originals kept for the viewer
const IMG = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'bmp', 'dng'];
const VID = ['mp4', 'mov', '3gp', 'mkv', 'webm', 'avi', 'm4v'];
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const key = (serial, it) => crypto.createHash('sha1').update(`${serial}\0${it.path}\0${it.size}\0${it.mtime}`).digest('hex');
const has = bin => { try { cp.execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }); return true; } catch (_) { return false; } };

class Photos {
  constructor({ nativeImage, log, mountDir } = {}) {
    this.nativeImage = nativeImage; this.log = log || (() => {}); this.mountDir = mountDir || (() => null);
    this.items = new Map();       // serial -> Map(id -> item)
    this.inflight = new Map(); this.queue = []; this.active = 0;
    this.ffmpeg = has('ffmpeg');
  }

  // ------------------------------------------------------------ listing
  async list(serial) {
    let items = [];
    const imgKeys = ['_id', '_data', 'datetaken', 'date_modified', 'width', 'height', 'mime_type', '_size', 'orientation', 'bucket_display_name'];
    const vidKeys = ['_id', '_data', 'datetaken', 'date_modified', 'width', 'height', 'mime_type', '_size', 'duration', 'bucket_display_name'];
    const [ims, vids] = await Promise.all([
      contentQuery(serial, 'content://media/external/images/media', imgKeys),
      contentQuery(serial, 'content://media/external/video/media', vidKeys),
    ]);
    if (ims || vids) {
      const conv = (r, kind) => {
        const p = phonePath(r._data || ''); if (!p || /\/Android\/data\//.test(p)) return null;
        const mtime = (+r.date_modified || 0) * 1000, taken = +r.datetaken || mtime;
        let w = +r.width || 0, ht = +r.height || 0; const rot = +r.orientation || 0;
        if (rot === 90 || rot === 270) [w, ht] = [ht, w];
        return { kind, mid: r._id, path: p, date: taken, mtime, size: +r._size || 0, w, h: ht, mime: r.mime_type || '', duration: (+r.duration || 0) / 1000,
          album: (r.bucket_display_name && r.bucket_display_name !== 'NULL') ? r.bucket_display_name : path.posix.basename(path.posix.dirname(p)) };
      };
      for (const r of ims || []) { const x = conv(r, 'image'); if (x) items.push(x); }
      for (const r of vids || []) { const x = conv(r, 'video'); if (x) items.push(x); }
    } else {
      const files = await findFiles(serial, IMG.concat(VID), '-size +1k', 'DCIM Pictures Movies Download Documents');
      items = files.map(f => {
        const ext = path.extname(f.path).slice(1).toLowerCase();
        return { kind: VID.includes(ext) ? 'video' : 'image', path: f.path, date: f.mtime, mtime: f.mtime, size: f.size, w: 0, h: 0, mime: '', duration: 0, album: path.posix.basename(path.posix.dirname(f.path)) };
      });
    }
    const map = new Map();
    for (const it of items) { it.id = key(serial, it).slice(0, 20); map.set(it.id, it); }
    this.items.set(serial, map);
    items.sort((a, b) => b.date - a.date);
    return items;
  }
  item(serial, id) { const m = this.items.get(serial); return m && m.get(id); }

  // ------------------------------------------------------------ thumbnails
  thumb(serial, id) {
    const it = this.item(serial, id); if (!it) return Promise.resolve(null);
    const k = key(serial, it), out = path.join(THUMBS, serial, k.slice(0, 2), k + '.jpg');
    if (fs.existsSync(out)) return Promise.resolve(out);
    if (this.inflight.has(out)) return this.inflight.get(out);
    const job = new Promise((res) => { this.queue.push({ run: () => this.makeThumb(serial, it, out).then(ok => res(ok ? out : null), () => res(null)) }); this.pump(); });
    this.inflight.set(out, job); job.finally(() => this.inflight.delete(out));
    return job;
  }
  pump() {
    while (this.active < 4 && this.queue.length) {
      const j = this.queue.pop();           // newest request first: what's on screen now
      this.active++;
      j.run().finally(() => { this.active--; this.pump(); });
    }
  }
  /** The file on the mounted phone drive, if there is one (random access, so ffmpeg only reads what it needs). */
  onDrive(p) { const m = this.mountDir(); if (!m) return null; const f = path.join(m, p.replace(/^\/(storage\/emulated\/0|sdcard)\/?/, '')); return fs.existsSync(f) ? f : null; }
  async makeThumb(serial, it, out) {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    if (it.kind === 'video') {
      if (!this.ffmpeg) return false;
      let src = this.onDrive(it.path), tmp = null;
      if (!src) { if (it.size > 600e6) return false; src = tmp = await this.full(serial, it.id); }
      if (!src) return false;
      return ffmpegFrame(src, out, Math.min(1, (it.duration || 2) / 3));
    }
    const src = await this.full(serial, it.id, { small: true });
    if (!src) return false;
    let data = null;
    if (this.nativeImage && !/heic|heif|dng/i.test(it.mime + src)) {
      try {
        let img = this.nativeImage.createFromPath(src);
        if (!img.isEmpty()) {
          const { width, height } = img.getSize();
          const scale = 480 / Math.min(width, height);
          if (scale < 1) img = img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
          data = withOrientation(img.toJPEG(82), jpegOrientation(src));
        }
      } catch (_) {}
    }
    if (!data && this.ffmpeg) return ffmpegFrame(src, out, 0);
    if (!data) return false;
    await fsp.writeFile(out, data);
    return true;
  }

  // ------------------------------------------------------------ originals
  async full(serial, id, { small } = {}) {
    const it = this.item(serial, id); if (!it) return null;
    const k = key(serial, it), ext = path.extname(it.path).toLowerCase() || '.bin';
    const dst = path.join(FULL, serial, k + ext);
    if (fs.existsSync(dst)) { const t = new Date(); fs.utimes(dst, t, t, () => {}); return dst; }
    const viaDrive = this.onDrive(it.path);
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const tmp = dst + '.part';
    if (viaDrive && small) return viaDrive;                // thumbnails of photos read straight from the drive
    await adb(serial, ['pull', it.path, tmp], { timeout: 30 * 60000 });
    await fsp.rename(tmp, dst);
    this.trim(serial).catch(() => {});
    return dst;
  }
  /** A version the viewer can show: HEIC/DNG converted to JPEG. */
  async viewable(serial, id) {
    const it = this.item(serial, id); const f = await this.full(serial, id); if (!f) return null;
    if (it.kind === 'image' && /\.(heic|heif|dng)$/i.test(f) && this.ffmpeg) {
      const j = f.replace(/\.[^.]+$/, '.view.jpg');
      if (!fs.existsSync(j)) await new Promise(r => cp.execFile('ffmpeg', ['-v', 'error', '-y', '-i', f, '-frames:v', '1', '-q:v', '3', j], { timeout: 120000 }, () => r()));
      if (fs.existsSync(j)) return j;
    }
    return f;
  }
  async trim(serial) {
    const dir = path.join(FULL, serial); const ents = [];
    for (const n of await fsp.readdir(dir)) { if (n.endsWith('.part')) continue; const st = await fsp.stat(path.join(dir, n)); ents.push([path.join(dir, n), st.size, st.atimeMs]); }
    let total = ents.reduce((a, e) => a + e[1], 0);
    for (const [f, size] of ents.sort((a, b) => a[2] - b[2])) { if (total <= FULL_CAP) break; await fsp.unlink(f).catch(() => {}); total -= size; }
  }

  // ------------------------------------------------------------ download / delete
  async download(serial, ids, dest, progress = () => {}) {
    await fsp.mkdir(dest, { recursive: true });
    let n = 0; const done = [];
    for (const id of ids) {
      const it = this.item(serial, id); if (!it) continue;
      progress({ i: ++n, n: ids.length, name: path.posix.basename(it.path) });
      let out = path.join(dest, path.posix.basename(it.path));
      if (fs.existsSync(out) && fs.statSync(out).size === it.size) { done.push(out); continue; }
      for (let i = 2; fs.existsSync(out); i++) out = path.join(dest, path.posix.basename(it.path).replace(/(\.[^.]+)?$/, ` (${i})$1`));
      const cached = path.join(FULL, serial, key(serial, it) + (path.extname(it.path).toLowerCase() || '.bin'));
      if (fs.existsSync(cached)) await fsp.copyFile(cached, out); else await adb(serial, ['pull', '-a', it.path, out], { timeout: 30 * 60000 });
      const t = new Date(it.date || it.mtime || Date.now()); await fsp.utimes(out, t, t).catch(() => {});
      done.push(out);
    }
    return done;
  }
  async remove(serial, ids) {
    const its = ids.map(id => this.item(serial, id)).filter(Boolean);
    for (let i = 0; i < its.length; i += 40) await sh(serial, 'rm -f ' + its.slice(i, i + 40).map(x => q(x.path)).join(' '), { timeout: 60000 });
    // drop them from Android's media index too, so the phone's gallery updates right away
    for (const it of its) {
      if (it.mid) await sh(serial, `content delete --uri content://media/external/${it.kind === 'video' ? 'video' : 'images'}/media/${it.mid}`, { timeout: 15000 }).catch(() => {});
      else await sh(serial, `am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d ${q('file://' + it.path)}`, { timeout: 15000 }).catch(() => {});
      this.items.get(serial).delete(it.id);
    }
    return its.length;
  }
}

function ffmpegFrame(src, out, at) {
  return new Promise(res => {
    const args = ['-v', 'error', '-y', ...(at ? ['-ss', String(at)] : []), '-i', src, '-frames:v', '1', '-vf', "scale='if(gt(iw,ih),-2,480)':'if(gt(iw,ih),480,-2)'", '-q:v', '4', out];
    cp.execFile('ffmpeg', args, { timeout: 60000 }, e => res(!e && fs.existsSync(out)));
  });
}

// ---------------------------------------------------------------- EXIF orientation
// Resizing drops the EXIF block, so the orientation is read from the original and written back into the
// thumbnail as a tiny EXIF segment; the page then shows it the right way up (image-orientation: from-image).
function jpegOrientation(file) {
  try {
    const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(128 * 1024); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd);
    if (b[0] !== 0xFF || b[1] !== 0xD8) return 1;
    let p = 2;
    while (p + 4 < n) {
      if (b[p] !== 0xFF) return 1;
      const m = b[p + 1], len = b.readUInt16BE(p + 2);
      if (m === 0xE1 && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
        const t = p + 10, le = b.toString('latin1', t, t + 2) === 'II';
        const u16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), u32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
        const ifd = t + u32(t + 4), cnt = u16(ifd);
        for (let i = 0; i < cnt; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) return u16(e + 8) || 1; }
        return 1;
      }
      if (m === 0xDA) return 1;
      p += 2 + len;
    }
  } catch (_) {}
  return 1;
}
function withOrientation(jpeg, o) {
  if (!o || o === 1) return jpeg;
  const tiff = Buffer.from([0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const seg = Buffer.concat([Buffer.from([0xFF, 0xE1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}

module.exports = { Photos, jpegOrientation, withOrientation };
