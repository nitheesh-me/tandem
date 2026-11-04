// Reading a Tandem invite on this device, for join/ and watch/. Nothing here
// touches the network: the invite stays after the #, which no server sees.

export const SITE = new URL('./', import.meta.url).href;
const PUBLIC_JOIN = 'https://nitheesh-me.github.io/tandem/join';
const LINK = 'tandem://join/';
const TICKET = /^tandem1[a-z2-7]+$/;

/** The ticket from a ticket, a tandem:// link, or a join page address. Null if none. */
export function ticketFrom(text) {
  let value = String(text ?? '').trim().replace(/\s+/g, '');
  if (!value) return null;
  for (const page of [PUBLIC_JOIN, new URL('join', SITE).href, new URL('watch', SITE).href]) {
    if (value.startsWith(page) && value.includes('#')) return ticketFrom(fromHash(value.split('#')[1]));
  }
  if (value.startsWith(LINK)) value = value.slice(LINK.length);
  value = value.replace(/\/$/, '').toLowerCase();
  return TICKET.test(value) ? value : null;
}

/** The join page carries the bare ticket after #; older links carry invite=. */
export function fromHash(hash) {
  const h = String(hash ?? '').replace(/^#/, '');
  if (h.startsWith('tandem1')) return h.split('&')[0];
  return new URLSearchParams(h).get('invite');
}

export const appLink = (ticket) => `${LINK}${ticket}`;
export const watchLink = (ticket) => `${new URL('watch/', SITE).href}#${new URLSearchParams({ invite: appLink(ticket) })}`;
export const joinLink = (ticket, extra = '') => `${new URL('join/', SITE).href}#${ticket}${extra}`;

function base32(text) {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567';
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const v = abc.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function varint(bytes, at) {
  let n = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && shift < 35; i++) {
    n |= (bytes[i] & 0x7f) << shift;
    shift += 7;
    if (!(bytes[i] & 0x80)) return [n >>> 0, i + 1];
  }
  return [null, at];
}

/**
 * What a ticket says: a 32-byte secret, then each Station's id and address
 * (postcard, as `tandem-core` writes it). A ticket that does not read to its
 * very end was cut short, which chat apps do to long links.
 */
export function readTicket(ticket) {
  if (!ticket || !TICKET.test(ticket)) return { ok: false, why: 'not' };
  const bytes = base32(ticket.slice(7));
  if (!bytes || bytes.length < 34) return { ok: false, why: 'cut' };
  let [count, at] = varint(bytes, 32);
  if (count === null || count < 1 || count > 64) return { ok: false, why: 'cut' };
  const relays = new Set();
  for (let s = 0; s < count; s++) {
    at += 32;
    let len;
    [len, at] = varint(bytes, at);
    if (len === null || at + len > bytes.length) return { ok: false, why: 'cut' };
    const text = new TextDecoder('latin1').decode(bytes.subarray(at, at + len));
    for (const m of text.matchAll(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}\.?\//gi)) relays.add(m[0]);
    at += len;
  }
  if (at !== bytes.length) return { ok: false, why: 'cut' };
  return { ok: true, stations: count, relays: [...relays], bytes };
}

export async function config() {
  const res = await fetch(new URL('config.json', SITE), { cache: 'no-cache' });
  return res.json();
}
