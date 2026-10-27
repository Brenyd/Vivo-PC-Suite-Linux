// Audio metadata reader: ID3v1/v2 (MP3), MP4/M4A (iTunes atoms), FLAC, Ogg Vorbis/Opus and WAV, in plain Node.
// Anything it can't read falls back to ffprobe (part of ffmpeg, which scrcpy already pulls in).
// readTags(file) -> { title, artist, albumArtist, album, genre, year, track, trackTotal, disc, discTotal,
//                     composer, comment, compilation, duration (s), bitrate (kbps), sampleRate, codec, picture: {mime, data} | null }
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process');

const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies',
  'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack',
  'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
  'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
  'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream',
  'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret',
  'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical',
  'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic',
  'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band',
  'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony',
  'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad',
  'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall'];

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.m4b', '.mp4', '.aac', '.flac', '.ogg', '.oga', '.opus', '.wav', '.aif', '.aiff', '.wma', '.alac', '.ape', '.wv']);

// ---------------------------------------------------------------- small helpers
const pair = s => { const m = String(s || '').match(/^\s*(\d+)?\s*(?:\/\s*(\d+))?/); return [m && m[1] ? +m[1] : 0, m && m[2] ? +m[2] : 0]; };
const year = s => { const m = String(s || '').match(/\d{4}/); return m ? +m[0] : 0; };
function genre(g) {
  if (!g) return '';
  g = String(g).replace(/\0+$/, '').trim();
  const m = g.match(/^\((\d+)\)(.*)$/); if (m) return m[2].trim() || GENRES[+m[1]] || '';
  if (/^\d+$/.test(g)) return GENRES[+g] || g;
  return g;
}
function readAt(fd, pos, len) { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return n < len ? b.subarray(0, n) : b; }
function decodeUtf16(b) {
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) { const s = Buffer.from(b.subarray(2, b.length - (b.length % 2))); s.swap16(); return s.toString('utf16le'); }
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) return b.subarray(2, b.length - (b.length % 2)).toString('utf16le');
  return b.subarray(0, b.length - (b.length % 2)).toString('utf16le');
}
function decodeText(enc, b) {
  let s;
  if (enc === 1) s = decodeUtf16(b);
  else if (enc === 2) { const c = Buffer.from(b.subarray(0, b.length - (b.length % 2))); c.swap16(); s = c.toString('utf16le'); }
  else if (enc === 3) s = b.toString('utf8');
  else s = b.toString('latin1');
  return s.replace(/\0+$/, '');
}
// split at the encoding's terminator; returns [first, rest]
function splitTerm(enc, b) {
  if (enc === 1 || enc === 2) { for (let i = 0; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return [b.subarray(0, i), b.subarray(i + 2)]; return [b, Buffer.alloc(0)]; }
  const i = b.indexOf(0); return i < 0 ? [b, Buffer.alloc(0)] : [b.subarray(0, i), b.subarray(i + 1)];
}
const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
function unsync(b) { const out = []; for (let i = 0; i < b.length; i++) { out.push(b[i]); if (b[i] === 0xFF && b[i + 1] === 0) i++; } return Buffer.from(out); }
function sniffMime(d) {
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0xFF && d[1] === 0xD8) return 'image/jpeg';
  if (d.subarray(0, 4).toString() === 'RIFF') return 'image/webp';
  if (d.subarray(0, 3).toString() === 'GIF') return 'image/gif';
  return 'image/jpeg';
}

// ---------------------------------------------------------------- ID3v2 + MPEG audio
function parseId3v2(fd, t) {
  const h = readAt(fd, 0, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return 0;
  const ver = h[3], flags = h[5], size = syncsafe(h, 6), end = 10 + size + (flags & 0x10 ? 10 : 0);
  let b = readAt(fd, 10, size);
  if (ver < 4 && flags & 0x80) b = unsync(b);
  let p = 0;
  if (flags & 0x40) p = ver === 4 ? syncsafe(b, 0) : b.readUInt32BE(0) + 4;
  const idLen = ver === 2 ? 3 : 4, hdrLen = ver === 2 ? 6 : 10;
  const MAP2 = { TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TCO: 'TCON', TYE: 'TYER', TRK: 'TRCK', TPA: 'TPOS', PIC: 'APIC', TCM: 'TCOM', COM: 'COMM', TCP: 'TCMP' };
  while (p + hdrLen <= b.length) {
    let id = b.toString('latin1', p, p + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    let len, fflags = 0;
    if (ver === 2) len = (b[p + 3] << 16) | (b[p + 4] << 8) | b[p + 5];
    else { len = ver === 4 ? syncsafe(b, p + 4) : b.readUInt32BE(p + 4); fflags = b.readUInt16BE(p + 8); }
    p += hdrLen;
    if (len <= 0 || p + len > b.length) break;
    let d = b.subarray(p, p + len); p += len;
    if (ver === 2) id = MAP2[id] || id;
    if (ver === 4) { if (fflags & 0x0002) d = unsync(d); if (fflags & 0x0001) d = d.subarray(4); if (fflags & 0x000C) continue; }
    try { id3Frame(id, d, t, ver); } catch (_) {}
  }
  return end;
}
function id3Frame(id, d, t, ver) {
  if (id === 'APIC') {
    if (t.picture && t.picture.type === 3) return;
    const enc = d[0]; let rest = d.subarray(1), mime;
    if (ver === 2) { mime = 'image/' + rest.toString('latin1', 0, 3).toLowerCase().replace('jpg', 'jpeg'); rest = rest.subarray(3); }
    else { const [m, r] = splitTerm(0, rest); mime = m.toString('latin1'); rest = r; }
    const type = rest[0]; const [, data] = splitTerm(enc, rest.subarray(1));
    if (data.length > 16) t.picture = { mime: /image\//.test(mime) ? mime : sniffMime(data), data: Buffer.from(data), type };
    return;
  }
  if (id === 'COMM') { const enc = d[0]; const [, txt] = splitTerm(enc, d.subarray(4)); if (!t.comment) t.comment = decodeText(enc, txt); return; }
  if (id === 'TXXX') {
    const enc = d[0]; const [k, v] = splitTerm(enc, d.subarray(1)); const key = decodeText(enc, k).toUpperCase(), val = decodeText(enc, v);
    if (key === 'ALBUM ARTIST' || key === 'ALBUMARTIST') t.albumArtist = t.albumArtist || val;
    return;
  }
  if (id[0] !== 'T') return;
  const v = decodeText(d[0], d.subarray(1)).split('\0')[0].trim();
  switch (id) {
    case 'TIT2': t.title = v; break;
    case 'TPE1': t.artist = v; break;
    case 'TPE2': t.albumArtist = v; break;
    case 'TALB': t.album = v; break;
    case 'TCON': t.genre = genre(v); break;
    case 'TCOM': t.composer = v; break;
    case 'TYER': case 'TDRC': case 'TDOR': if (!t.year) t.year = year(v); break;
    case 'TRCK': [t.track, t.trackTotal] = pair(v); break;
    case 'TPOS': [t.disc, t.discTotal] = pair(v); break;
    case 'TCMP': t.compilation = v === '1'; break;
  }
}
function parseId3v1(fd, size, t) {
  if (size < 128) return false;
  const b = readAt(fd, size - 128, 128);
  if (b.toString('latin1', 0, 3) !== 'TAG') return false;
  const s = (o, l) => b.toString('latin1', o, o + l).replace(/\0.*$/, '').trim();
  t.title = t.title || s(3, 30); t.artist = t.artist || s(33, 30); t.album = t.album || s(63, 30);
  t.year = t.year || year(s(93, 4));
  if (b[125] === 0 && b[126]) t.track = t.track || b[126];
  if (!t.genre && b[127] < GENRES.length) t.genre = GENRES[b[127]];
  return true;
}
const BR = { // [version][layer] kbps tables
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const SR = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
function mpegHeader(b, i) {
  if (b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null;
  const vb = (b[i + 1] >> 3) & 3, lb = (b[i + 1] >> 1) & 3, bi = (b[i + 2] >> 4) & 15, si = (b[i + 2] >> 2) & 3;
  if (vb === 1 || lb === 0 || bi === 0 || bi === 15 || si === 3) return null;
  const ver = vb === 3 ? 1 : vb === 2 ? 2 : 2.5, layer = 4 - lb;
  const kbps = BR[ver === 1 ? 1 : 2][layer][bi], sr = SR[ver][si], mono = ((b[i + 3] >> 6) & 3) === 3;
  const spf = layer === 1 ? 384 : layer === 3 && ver !== 1 ? 576 : 1152;
  const pad = (b[i + 2] >> 1) & 1;
  const flen = layer === 1 ? Math.floor((12 * kbps * 1000 / sr + pad) * 4) : Math.floor(spf / 8 * kbps * 1000 / sr) + pad;
  return { ver, layer, kbps, sr, mono, spf, flen };
}
function mp3Audio(fd, start, size, hasV1, t) {
  const b = readAt(fd, start, 64 * 1024);
  for (let i = 0; i + 4 < b.length; i++) {
    const h = mpegHeader(b, i);
    if (!h) continue;
    const n = mpegHeader(b, i + h.flen);          // confirm with the next frame
    if (!n && i + h.flen + 4 < b.length) continue;
    t.sampleRate = h.sr; t.codec = 'mp3';
    const side = h.ver === 1 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
    const x = i + 4 + side, tag = b.toString('latin1', x, x + 4);
    const audioBytes = size - start - i - (hasV1 ? 128 : 0);
    if ((tag === 'Xing' || tag === 'Info') && b[x + 7] & 1) {
      const frames = b.readUInt32BE(x + 8);
      t.duration = frames * h.spf / h.sr;
      t.bitrate = t.duration ? Math.round(audioBytes * 8 / t.duration / 1000) : h.kbps;
    } else if (b.toString('latin1', i + 36, i + 40) === 'VBRI') {
      const frames = b.readUInt32BE(i + 36 + 14);
      t.duration = frames * h.spf / h.sr; t.bitrate = Math.round(audioBytes * 8 / t.duration / 1000);
    } else { t.bitrate = h.kbps; t.duration = audioBytes * 8 / (h.kbps * 1000); }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- MP4 / M4A
function mp4(fd, size, t) {
  const h = readAt(fd, 4, 4).toString('latin1');
  if (h !== 'ftyp') return false;
  let pos = 0;
  while (pos + 8 <= size) {
    const hd = readAt(fd, pos, 16);
    let len = hd.readUInt32BE(0); const type = hd.toString('latin1', 4, 8); let hl = 8;
    if (len === 1) { len = Number(hd.readBigUInt64BE(8)); hl = 16; } else if (len === 0) len = size - pos;
    if (len < 8) break;
    if (type === 'moov') { mp4Moov(readAt(fd, pos + hl, len - hl), t); t.codec = t.codec || 'aac'; if (t.duration) t.bitrate = t.bitrate || Math.round(size * 8 / t.duration / 1000); return true; }
    pos += len;
  }
  return true;
}
function* atoms(b, start = 0, end = b.length) {
  let p = start;
  while (p + 8 <= end) {
    let len = b.readUInt32BE(p); const type = b.toString('latin1', p + 4, p + 8); let hl = 8;
    if (len === 1) { len = Number(b.readBigUInt64BE(p + 8)); hl = 16; } else if (len === 0) len = end - p;
    if (len < 8 || p + len > end) return;
    yield { type, s: p + hl, e: p + len };
    p += len;
  }
}
function mp4Moov(b, t) {
  for (const a of atoms(b)) {
    if (a.type === 'mvhd') {
      const v = b[a.s];
      const ts = v === 1 ? b.readUInt32BE(a.s + 20) : b.readUInt32BE(a.s + 12);
      const du = v === 1 ? Number(b.readBigUInt64BE(a.s + 24)) : b.readUInt32BE(a.s + 16);
      if (ts) t.duration = du / ts;
    } else if (a.type === 'udta') {
      for (const u of atoms(b, a.s, a.e)) if (u.type === 'meta') for (const m of atoms(b, u.s + 4, u.e)) if (m.type === 'ilst') mp4Ilst(b, m, t);
    } else if (a.type === 'trak') mp4Codec(b, a, t);
  }
}
function mp4Codec(b, a, t) {
  const find = (s, e, path) => { for (const x of atoms(b, s, e)) if (x.type === path[0]) return path.length === 1 ? x : find(x.s, x.e, path.slice(1)); return null; };
  const stsd = find(a.s, a.e, ['mdia', 'minf', 'stbl', 'stsd']);
  if (!stsd || stsd.s + 16 > stsd.e) return;
  const fmt = b.toString('latin1', stsd.s + 12, stsd.s + 16);
  const MAP = { mp4a: 'aac', alac: 'alac', 'ac-3': 'ac3', 'ec-3': 'eac3', fLaC: 'flac', Opus: 'opus', '.mp3': 'mp3' };
  if (MAP[fmt]) { t.codec = MAP[fmt]; if (stsd.s + 8 + 36 <= stsd.e) { const sr = b.readUInt32BE(stsd.s + 8 + 32) >>> 16; if (sr) t.sampleRate = sr; } }
}
function mp4Ilst(b, il, t) {
  for (const it of atoms(b, il.s, il.e)) {
    let name = it.type, data = null, dtype = 0;
    for (const x of atoms(b, it.s, it.e)) {
      if (x.type === 'data') { dtype = b.readUInt32BE(x.s) & 0xffffff; data = b.subarray(x.s + 8, x.e); }
      else if (x.type === 'name' && name === '----') name = '----:' + b.toString('utf8', x.s + 4, x.e);
    }
    if (!data) continue;
    const str = () => data.toString('utf8').replace(/\0+$/, '').trim();
    switch (name) {
      case '©nam': t.title = str(); break;
      case '©ART': t.artist = str(); break;
      case 'aART': t.albumArtist = str(); break;
      case '©alb': t.album = str(); break;
      case '©gen': t.genre = str(); break;
      case '©wrt': t.composer = str(); break;
      case '©cmt': t.comment = str(); break;
      case '©day': t.year = year(str()); break;
      case 'gnre': if (data.length >= 2) t.genre = t.genre || GENRES[data.readUInt16BE(0) - 1] || ''; break;
      case 'trkn': if (data.length >= 6) { t.track = data.readUInt16BE(2); t.trackTotal = data.readUInt16BE(4); } break;
      case 'disk': if (data.length >= 6) { t.disc = data.readUInt16BE(2); t.discTotal = data.readUInt16BE(4); } break;
      case 'cpil': t.compilation = data[0] === 1; break;
      case 'covr': if (!t.picture && data.length > 16) t.picture = { mime: dtype === 14 ? 'image/png' : sniffMime(data), data: Buffer.from(data) }; break;
    }
  }
}

// ---------------------------------------------------------------- Vorbis comments (FLAC / Ogg)
function vorbisComments(b, t) {
  let p = 0; const vlen = b.readUInt32LE(p); p += 4 + vlen;
  const n = b.readUInt32LE(p); p += 4;
  for (let i = 0; i < n && p + 4 <= b.length; i++) {
    const l = b.readUInt32LE(p); p += 4;
    const s = b.toString('utf8', p, p + l); p += l;
    const eq = s.indexOf('='); if (eq < 0) continue;
    const k = s.slice(0, eq).toUpperCase(), v = s.slice(eq + 1).trim();
    switch (k) {
      case 'TITLE': t.title = v; break;
      case 'ARTIST': t.artist = t.artist ? t.artist : v; break;
      case 'ALBUMARTIST': case 'ALBUM ARTIST': case 'ALBUM_ARTIST': t.albumArtist = v; break;
      case 'ALBUM': t.album = v; break;
      case 'GENRE': t.genre = t.genre || genre(v); break;
      case 'COMPOSER': t.composer = v; break;
      case 'COMMENT': case 'DESCRIPTION': t.comment = t.comment || v; break;
      case 'DATE': case 'YEAR': t.year = t.year || year(v); break;
      case 'TRACKNUMBER': { const [a, bb] = pair(v); t.track = a; if (bb) t.trackTotal = bb; break; }
      case 'TRACKTOTAL': case 'TOTALTRACKS': t.trackTotal = +v || t.trackTotal; break;
      case 'DISCNUMBER': { const [a, bb] = pair(v); t.disc = a; if (bb) t.discTotal = bb; break; }
      case 'DISCTOTAL': case 'TOTALDISCS': t.discTotal = +v || t.discTotal; break;
      case 'COMPILATION': t.compilation = v === '1'; break;
      case 'METADATA_BLOCK_PICTURE': if (!t.picture) try { flacPicture(Buffer.from(v, 'base64'), t); } catch (_) {} break;
    }
  }
}
function flacPicture(b, t) {
  let p = 4; const ml = b.readUInt32BE(p); p += 4; const mime = b.toString('latin1', p, p + ml); p += ml;
  const dl = b.readUInt32BE(p); p += 4 + dl + 16; const len = b.readUInt32BE(p); p += 4;
  const data = b.subarray(p, p + len);
  if (data.length > 16) t.picture = { mime: mime || sniffMime(data), data: Buffer.from(data) };
}
function flac(fd, start, size, t) {
  if (readAt(fd, start, 4).toString('latin1') !== 'fLaC') return false;
  let p = start + 4, last = false;
  t.codec = 'flac';
  while (!last && p + 4 <= size) {
    const h = readAt(fd, p, 4); last = !!(h[0] & 0x80); const type = h[0] & 0x7f, len = (h[1] << 16) | (h[2] << 8) | h[3]; p += 4;
    if (type === 0) {
      const b = readAt(fd, p, len);
      const sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const total = (b[13] & 0x0f) * 2 ** 32 + b.readUInt32BE(14);
      t.sampleRate = sr; if (sr && total) t.duration = total / sr;
    } else if (type === 4) vorbisComments(readAt(fd, p, len), t);
    else if (type === 6 && !t.picture) flacPicture(readAt(fd, p, len), t);
    p += len;
  }
  if (t.duration) t.bitrate = Math.round((size - p) * 8 / t.duration / 1000);
  return true;
}
function ogg(fd, size, t) {
  const b = readAt(fd, 0, Math.min(size, 4 * 1024 * 1024));
  if (b.toString('latin1', 0, 4) !== 'OggS') return false;
  // reassemble the first packets
  const packets = []; let cur = [], p = 0;
  while (p + 27 <= b.length && packets.length < 3) {
    if (b.toString('latin1', p, p + 4) !== 'OggS') break;
    const segs = b[p + 26]; let q = p + 27 + segs;
    for (let i = 0; i < segs; i++) { const l = b[p + 27 + i]; cur.push(b.subarray(q, q + l)); q += l; if (l < 255) { packets.push(Buffer.concat(cur)); cur = []; } }
    p = q;
  }
  const id = packets[0] || Buffer.alloc(0); let preskip = 0, rate = 0;
  if (id.toString('latin1', 0, 8) === 'OpusHead') { t.codec = 'opus'; preskip = id.readUInt16LE(10); rate = 48000; t.sampleRate = id.readUInt32LE(12) || 48000; }
  else if (id.toString('latin1', 1, 7) === 'vorbis') { t.codec = 'vorbis'; rate = t.sampleRate = id.readUInt32LE(12); }
  else if (id.toString('latin1', 1, 5) === 'FLAC') { t.codec = 'flac'; }
  const c = packets[1];
  if (c) { if (c.toString('latin1', 0, 8) === 'OpusTags') vorbisComments(c.subarray(8), t); else if (c.toString('latin1', 1, 7) === 'vorbis') vorbisComments(c.subarray(7), t); }
  if (rate) {
    const tail = readAt(fd, Math.max(0, size - 65536), Math.min(size, 65536));
    const i = tail.lastIndexOf('OggS');
    if (i >= 0 && i + 14 <= tail.length) { const g = Number(tail.readBigUInt64LE(i + 6)); if (g > 0) t.duration = (g - preskip) / rate; }
    if (t.duration) t.bitrate = Math.round(size * 8 / t.duration / 1000);
  }
  return true;
}
function wav(fd, size, t) {
  const h = readAt(fd, 0, 12);
  if (h.toString('latin1', 0, 4) !== 'RIFF' || h.toString('latin1', 8, 12) !== 'WAVE') return false;
  t.codec = 'pcm';
  let p = 12, byteRate = 0, dataLen = 0;
  while (p + 8 <= size) {
    const c = readAt(fd, p, 8); const id = c.toString('latin1', 0, 4), len = c.readUInt32LE(4);
    if (id === 'fmt ') { const f = readAt(fd, p + 8, 16); t.sampleRate = f.readUInt32LE(4); byteRate = f.readUInt32LE(8); }
    else if (id === 'data') dataLen = len;
    else if (id === 'LIST') {
      const l = readAt(fd, p + 8, Math.min(len, 65536));
      if (l.toString('latin1', 0, 4) === 'INFO') for (let q = 4; q + 8 <= l.length;) {
        const k = l.toString('latin1', q, q + 4), n = l.readUInt32LE(q + 4), v = l.toString('utf8', q + 8, q + 8 + n).replace(/\0+$/, '').trim();
        if (k === 'INAM') t.title = v; else if (k === 'IART') t.artist = v; else if (k === 'IPRD') t.album = v; else if (k === 'IGNR') t.genre = v;
        else if (k === 'ICRD') t.year = year(v); else if (k === 'ITRK') t.track = pair(v)[0];
        q += 8 + n + (n & 1);
      }
    } else if (id === 'id3 ' || id === 'ID3 ') { /* rare; ignore */ }
    p += 8 + len + (len & 1);
  }
  if (byteRate && dataLen) { t.duration = dataLen / byteRate; t.bitrate = Math.round(byteRate * 8 / 1000); }
  return true;
}

// ---------------------------------------------------------------- ffprobe fallback
let ffprobeOk = null;
function hasFfprobe() {
  if (ffprobeOk === null) try { cp.execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 }); ffprobeOk = true; } catch (_) { ffprobeOk = false; }
  return ffprobeOk;
}
function ffprobe(file, t) {
  return new Promise(res => {
    if (!hasFfprobe()) return res(false);
    cp.execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 20000, maxBuffer: 8 << 20 }, (e, out) => {
      if (e) return res(false);
      try {
        const j = JSON.parse(out), f = j.format || {}, a = (j.streams || []).find(s => s.codec_type === 'audio') || {};
        const tg = {}; for (const src of [f.tags || {}, a.tags || {}]) for (const [k, v] of Object.entries(src)) tg[k.toLowerCase()] = v;
        t.title = t.title || tg.title || ''; t.artist = t.artist || tg.artist || ''; t.album = t.album || tg.album || '';
        t.albumArtist = t.albumArtist || tg.album_artist || tg.albumartist || ''; t.genre = t.genre || genre(tg.genre);
        t.composer = t.composer || tg.composer || ''; t.year = t.year || year(tg.date || tg.year);
        if (!t.track && tg.track) [t.track, t.trackTotal] = pair(tg.track);
        if (!t.disc && tg.disc) [t.disc, t.discTotal] = pair(tg.disc);
        t.duration = t.duration || +f.duration || +a.duration || 0;
        t.bitrate = t.bitrate || Math.round((+f.bit_rate || +a.bit_rate || 0) / 1000);
        t.sampleRate = t.sampleRate || +a.sample_rate || 0; t.codec = t.codec || a.codec_name || '';
        t.hasEmbeddedArt = (j.streams || []).some(s => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
        res(true);
      } catch (_) { res(false); }
    });
  });
}
function ffArt(file) {
  return new Promise(res => {
    if (!hasFfprobe()) return res(null);
    cp.execFile('ffmpeg', ['-v', 'quiet', '-i', file, '-an', '-map', '0:v:0', '-c', 'copy', '-f', 'image2pipe', '-'], { encoding: 'buffer', timeout: 20000, maxBuffer: 32 << 20 }, (e, out) => {
      res(!e && out && out.length > 16 ? { mime: sniffMime(out), data: out } : null);
    });
  });
}

// ---------------------------------------------------------------- entry point
async function readTags(file) {
  const t = { title: '', artist: '', albumArtist: '', album: '', genre: '', composer: '', comment: '', year: 0, track: 0, trackTotal: 0,
    disc: 0, discTotal: 0, compilation: false, duration: 0, bitrate: 0, sampleRate: 0, codec: '', picture: null };
  const ext = path.extname(file).toLowerCase();
  let ok = false;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (['.m4a', '.m4b', '.mp4', '.alac'].includes(ext)) ok = mp4(fd, size, t);
    else if (['.ogg', '.oga', '.opus'].includes(ext)) ok = ogg(fd, size, t);
    else if (ext === '.wav') ok = wav(fd, size, t);
    else if (ext === '.flac' || ext === '.mp3') {
      const start = parseId3v2(fd, t);
      if (ext === '.flac') ok = flac(fd, start, size, t);
      else { const v1 = parseId3v1(fd, size, t); ok = mp3Audio(fd, start, size, v1, t); }
    }
  } catch (_) { ok = false; } finally { fs.closeSync(fd); }
  if (!ok || !t.duration) await ffprobe(file, t);
  if (!t.picture && t.hasEmbeddedArt) t.picture = await ffArt(file);
  delete t.hasEmbeddedArt;
  if (t.picture) delete t.picture.type;
  for (const k of ['title', 'artist', 'albumArtist', 'album', 'genre', 'composer', 'comment']) t[k] = String(t[k] || '').replace(/\0/g, '').trim();
  return t;
}

module.exports = { readTags, AUDIO_EXT, GENRES, hasFfprobe };
