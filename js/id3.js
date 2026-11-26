/**
 * ID3v2 parser (read-only) — pure JavaScript, no dependencies.
 *
 * Reads the frames the player cares about:
 *   APIC / PIC   album cover image
 *   USLT / ULT   (time-synced) lyrics, "일한 병기" lines
 *   TIT2/TPE1/TPE2/TALB/TDRC/TRCK …  basic text frames
 *
 * Supports ID3v2.2, v2.3 and v2.4, tag-level and frame-level
 * unsynchronisation, extended headers and data-length indicators.
 */

const decUtf8 = new TextDecoder('utf-8');
const decLatin1 = new TextDecoder('windows-1252');
const decUtf16le = new TextDecoder('utf-16le');
const decUtf16be = new TextDecoder('utf-16be');

function syncsafe(bytes, off) {
  return ((bytes[off] & 0x7f) << 21) | ((bytes[off + 1] & 0x7f) << 14) |
    ((bytes[off + 2] & 0x7f) << 7) | (bytes[off + 3] & 0x7f);
}

function u32(bytes, off) {
  return (bytes[off] << 24 >>> 0) + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
}

function deunsync(bytes) {
  const out = new Uint8Array(bytes.length);
  let j = 0;
  for (let i = 0; i < bytes.length; i++) {
    out[j++] = bytes[i];
    if (bytes[i] === 0xff && bytes[i + 1] === 0x00) i++;
  }
  return out.slice(0, j);
}

/** Decode a text payload by ID3 encoding byte. */
function decodeText(bytes, encoding) {
  let s = '';
  try {
    switch (encoding) {
      case 0: s = decLatin1.decode(bytes); break;
      case 1:
        if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) s = decUtf16be.decode(bytes.subarray(2));
        else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) s = decUtf16le.decode(bytes.subarray(2));
        else s = decUtf16le.decode(bytes);
        break;
      case 2: s = decUtf16be.decode(bytes); break;
      case 3: s = decUtf8.decode(bytes); break;
      default: s = decLatin1.decode(bytes);
    }
  } catch {
    s = decLatin1.decode(bytes);
  }
  return s.replace(/\u0000+$/g, '').replace(/\u0000/g, '');
}

/** Find the offset just past a null terminator for the given encoding. */
function afterTerminator(bytes, start, encoding) {
  const wide = encoding === 1 || encoding === 2;
  if (wide) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i + 2;
    }
    return bytes.length;
  }
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0) return i + 1;
  }
  return bytes.length;
}

function readAscii(bytes, off, len) {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

function parseApic(data, version) {
  if (!data.length) return null;
  const enc = data[0];
  let p = 1;
  let mime = 'image/jpeg';
  if (version === 2) {
    const fmt = readAscii(data, 1, 3).toLowerCase();
    mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
    p = 4;
  } else {
    const mimeEnd = afterTerminator(data, 1, 0);
    mime = readAscii(data, 1, Math.max(0, mimeEnd - 1 - 1)).trim() || 'image/jpeg';
    p = mimeEnd;
  }
  p += 1; // picture type
  p = afterTerminator(data, p, enc); // description
  if (p >= data.length) return null;
  const bytes = data.subarray(p);
  if (bytes.length < 4) return null;
  return { mime: mime.includes('/') ? mime : 'image/jpeg', bytes };
}

/**
 * Time-synced lyrics → [{ time, orig, trans }]
 * Accepts "[mm:ss.xx] 原文 / 번역" (one or more timestamps per line),
 * "[mm:ss]" and plain "/" separators. Header lines without a
 * timestamp are ignored.
 */
export function parseSyncedLyrics(text) {
  if (!text) return [];
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const last = stamps[stamps.length - 1];
    let body = line.slice(last.index + last[0].length).trim();
    let orig = body;
    let trans = '';
    let sep = body.indexOf(' / ');
    if (sep < 0) {
      const m = body.match(/\s\/\s?/);
      if (m) sep = m.index;
    }
    if (sep >= 0) {
      orig = body.slice(0, sep).trim().replace(/\s+$/, '');
      trans = body.slice(sep + (body.slice(sep).match(/^\s\/\s?/) || [' / '])[0].length).trim();
    }
    for (const st of stamps) {
      const min = parseInt(st[1], 10);
      const sec = parseInt(st[2], 10);
      const frac = st[3] ? parseInt(st[3].padEnd(3, '0'), 10) / 1000 : 0;
      out.push({ time: min * 60 + sec + frac, orig, trans });
    }
  }
  out.sort((a, b) => a.time - b.time);
  // Drop duplicate timestamps that repeat the same text.
  return out.filter((l, i) => i === 0 || l.time !== out[i - 1].time || l.orig !== out[i - 1].orig);
}

/** Length in bytes of the whole ID3 tag, from its first 10 bytes. */
export function id3TagLength(head) {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head);
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
  const major = bytes[3];
  let total = 10 + syncsafe(bytes, 6);
  if (major === 4 && (bytes[5] & 0x10)) total += 10; // footer
  return total;
}

/**
 * Parse an ID3v2 tag.
 * @param {ArrayBuffer|Uint8Array} buffer bytes starting at the tag
 * @returns {null|object} tag fields, cover {mime, bytes} and lyrics
 */
export function parseId3(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 10) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null;

  const major = bytes[3];
  const flags = bytes[5];
  const tagSize = syncsafe(bytes, 6);
  const end = Math.min(bytes.length, 10 + tagSize);
  let body = bytes.subarray(10, end);
  if ((major === 2 || major === 3) && (flags & 0x80)) {
    body = deunsync(body);
  }

  const tags = {
    version: `2.${major}.${bytes[4]}`,
    title: '', artist: '', album: '', albumArtist: '', year: '', track: '',
    cover: null, lyrics: [], plainLyrics: '', tagSize: 10 + tagSize,
  };

  let pos = 0;
  if (flags & 0x40) {
    if (major === 3) pos = 4 + u32(body, 0);
    else if (major === 4) pos = syncsafe(body, 0);
    else pos = 0;
  }

  const headerLen = major === 2 ? 6 : 10;
  while (pos + headerLen <= body.length) {
    const id = readAscii(body, pos, major === 2 ? 3 : 4);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;

    let size, frameFlags = 0;
    if (major === 2) {
      size = (body[pos + 3] << 16) + (body[pos + 4] << 8) + body[pos + 5];
    } else if (major === 4) {
      size = syncsafe(body, pos + 4);
      frameFlags = body[pos + 9];
    } else {
      size = u32(body, pos + 4);
      frameFlags = body[pos + 9];
    }
    if (size <= 0) break;
    let start = pos + headerLen;
    let stop = Math.min(start + size, body.length);
    if (stop <= start) break;

    let data = body.subarray(start, stop);
    if (major === 4 && frameFlags) {
      if (frameFlags & 0x01 && data.length >= 4) data = data.subarray(4); // data length indicator
      if (frameFlags & 0x02) data = deunsync(data);
    }

    try {
      switch (id) {
        case 'TIT2': case 'TT2': tags.title = decodeText(data.subarray(1), data[0]); break;
        case 'TPE1': case 'TP1': tags.artist = decodeText(data.subarray(1), data[0]); break;
        case 'TPE2': case 'TP2': tags.albumArtist = decodeText(data.subarray(1), data[0]); break;
        case 'TALB': case 'TAL': tags.album = decodeText(data.subarray(1), data[0]); break;
        case 'TDRC': case 'TYER': case 'TYE': tags.year = decodeText(data.subarray(1), data[0]); break;
        case 'TRCK': case 'TRK': tags.track = decodeText(data.subarray(1), data[0]); break;
        case 'APIC': case 'PIC': {
          if (!tags.cover) tags.cover = parseApic(data, major);
          break;
        }
        case 'USLT': case 'ULT': {
          const enc = data[0];
          let p = 1;
          p += major === 2 ? 3 : 3; // language
          p = afterTerminator(data, p, enc);
          const text = decodeText(data.subarray(p), enc);
          if (text.trim().length > (tags.plainLyrics.length)) tags.plainLyrics = text;
          break;
        }
        default: break;
      }
    } catch {
      /* a broken frame must not break the tag */
    }

    pos = stop;
  }

  if (!tags.title) tags.title = '';
  tags.lyrics = parseSyncedLyrics(tags.plainLyrics);
  if (tags.lyrics.length) tags.plainLyrics = '';
  return tags;
}
