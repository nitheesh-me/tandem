// A song on the browser version: what the app's audio stage shows, from the
// song's own ID3 tags. The cover art, the title and artist, and timed lyrics
// (LRC text in an unsynchronised lyrics frame) are read from the start of the
// file, through the same Service Worker address the <video> plays.

/** Larger tags are not worth the wait. */
const MAX_TAG = 4 * 1024 * 1024;
/** A line shows until the next, but not for ever over an instrumental break. */
const LONGEST_LINE = 8;

const syncsafe = (b, i) => ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f);
const plain32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

function decode(enc, bytes) {
  const label = enc === 0 ? 'latin1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/, '');
}

/** Where a terminated string ends: one zero byte, or two aligned ones in UTF-16. */
function stringEnd(enc, b, from) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i < 0 ? b.length : i;
}

const skipTerm = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

/** Undoes ID3 unsynchronisation: 0xFF 0x00 becomes 0xFF. */
function resync(b) {
  const out = [];
  for (let i = 0; i < b.length; i++) {
    out.push(b[i]);
    if (b[i] === 0xff && b[i + 1] === 0) i++;
  }
  return Uint8Array.from(out);
}

/** ID3v2.3 and v2.4 frames: title, artist, front cover, and lyrics with their language. */
export function readId3(buf) {
  let b = new Uint8Array(buf);
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const version = b[3];
  if (version < 3 || version > 4) return null;
  const flags = b[5];
  const size = syncsafe(b, 6);
  b = b.subarray(10, 10 + size);
  if (version === 3 && flags & 0x80) b = resync(b);
  let at = 0;
  if (flags & 0x40) at += version === 4 ? syncsafe(b, 0) : plain32(b, 0) + 4;
  const tags = { title: null, artist: null, cover: null, lyrics: [] };
  while (at + 10 <= b.length) {
    const id = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = version === 4 ? syncsafe(b, at + 4) : plain32(b, at + 4);
    const fflags = b[at + 9];
    let body = b.subarray(at + 10, at + 10 + len);
    at += 10 + len;
    if (version === 4) {
      if (fflags & 0x0c) continue; // compressed or encrypted
      if (fflags & 0x01) body = body.subarray(4); // data length indicator
      if (fflags & 0x02) body = resync(body);
    }
    if (!body.length) continue;
    const enc = body[0];
    if (id === 'TIT2') tags.title ??= decode(enc, body.subarray(1)).split('\0')[0];
    else if (id === 'TPE1') tags.artist ??= decode(enc, body.subarray(1)).split('\0')[0];
    else if (id === 'APIC') {
      const mimeEnd = body.indexOf(0, 1);
      const mime = new TextDecoder('latin1').decode(body.subarray(1, mimeEnd)) || 'image/jpeg';
      const kind = body[mimeEnd + 1];
      const descEnd = stringEnd(enc, body, mimeEnd + 2);
      const data = body.slice(descEnd + skipTerm(enc));
      // The front cover wins; any picture will do without one.
      if (!tags.cover || kind === 3) tags.cover = { mime: mime.includes('/') ? mime : `image/${mime.toLowerCase()}`, data, front: kind === 3 };
    } else if (id === 'USLT') {
      const language = new TextDecoder('latin1').decode(body.subarray(1, 4)).toLowerCase();
      const descEnd = stringEnd(enc, body, 4);
      const text = decode(enc, body.subarray(descEnd + skipTerm(enc)));
      if (text.trim()) tags.lyrics.push({ language: /^[a-z]{3}$/.test(language) && language !== 'xxx' ? language : null, text });
    }
  }
  return tags;
}

/** Timed LRC lines, as the app reads them (word stamps are dropped here). */
export function parseLrc(text) {
  let offset = 0;
  let language = null;
  const lines = [];
  const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const tag = /^\s*\[([a-z]+):(.*)\]\s*$/i.exec(line);
    if (tag && !/^\d+$/.test(tag[1])) {
      const key = tag[1].toLowerCase();
      const value = tag[2].trim();
      if (key === 'offset' && Number.isFinite(Number(value))) offset = Number(value) / 1000;
      if (key === 'la' || key === 'lang' || key === 'language') language = value.toLowerCase() || null;
      continue;
    }
    const stamps = [...line.matchAll(STAMP)];
    if (!stamps.length || line.trimStart().indexOf('[') !== 0) continue;
    const raw = line.replace(STAMP, '').replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').replace(/\s+/g, ' ').trim();
    for (const s of stamps) lines.push({ start: Math.max(0, Number(s[1]) * 60 + Number(s[2].replace(':', '.')) - offset), text: raw });
  }
  lines.sort((a, b) => a.start - b.start);
  const cues = lines.map((l, i) => ({ ...l, end: Math.min(lines[i + 1]?.start ?? Infinity, l.start + LONGEST_LINE) })).filter((c) => c.text && c.end > c.start);
  return { cues, language };
}

const timed = (text) => /^\s*\[\d{1,3}:\d{2}/m.test(text);

/**
 * Reads a song's tags from `url` (an address that answers Range requests).
 * Resolves to { title, artist, cover (a Blob or null), lyrics ({ cues, language }) or null }.
 */
export async function readSong(url, signal) {
  const head = await fetch(url, { headers: { Range: 'bytes=0-9' }, signal });
  const first = new Uint8Array(await head.arrayBuffer()).subarray(0, 10);
  if (first.length < 10 || first[0] !== 0x49 || first[1] !== 0x44 || first[2] !== 0x33) return null;
  const size = 10 + syncsafe(first, 6) + (first[5] & 0x10 ? 10 : 0);
  if (size > MAX_TAG) return null;
  const res = await fetch(url, { headers: { Range: `bytes=0-${size - 1}` }, signal });
  const tags = readId3(await res.arrayBuffer());
  if (!tags) return null;
  const lrc = tags.lyrics.find((l) => timed(l.text));
  const lyrics = lrc ? parseLrc(lrc.text) : null;
  if (lyrics && !lyrics.language) lyrics.language = lrc.language;
  return {
    title: tags.title, artist: tags.artist,
    cover: tags.cover ? new Blob([tags.cover.data], { type: tags.cover.mime }) : null,
    lyrics: lyrics?.cues.length ? lyrics : null,
  };
}

/** The cue playing at `t` seconds, and the one after it. */
export function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  const now = at >= 0 && t < cues[at].end ? cues[at] : null;
  return { now, next: cues[at + 1] ?? null };
}
