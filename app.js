// Fills the page from config.json. A ticket link overrides the ticket through the
// part of the address after #, which browsers never send to a server, so a room
// invite in a link stays between the people who have it.
//
// A pass with an invite opens the app if it is installed and otherwise the
// browser version. join/ and watch/ have their own scripts (invite.js).
const $ = (id) => document.getElementById(id);
const INVITE = /^tandem:\/\/join\/tandem1[a-z2-7]+\/?$/;
const TICKET = /^tandem1[a-z2-7]+$/;
const FIELDS = ['show', 'line', 'venue', 'date', 'time', 'seat', 'admit'];
// The site's root, wherever the page sits under it.
const BASE = new URL('.', document.currentScript.src);
// The join page as the app writes it, and as this copy of the site serves it.
const JOIN_PAGES = ['https://nitheesh-me.github.io/tandem/join', new URL('join', BASE).href];
const PACKAGE = 'app.tandem.desktop';
const ANDROID = /Android/i.test(navigator.userAgent);
// How long the app has to take over before the browser version opens instead.
const APP_WAIT_MS = 1600;

/** Only a real Tandem invite may become a link. Anything else in an address is ignored. */
function inviteFrom(text) {
  const value = (text ?? '').trim();
  if (INVITE.test(value)) return value.replace(/\/$/, '');
  if (TICKET.test(value)) return `tandem://join/${value}`;
  // The app's own invite: the join page with the ticket after the #.
  if (JOIN_PAGES.some((page) => value.startsWith(page)) && value.includes('#')) return inviteFrom(fromHash(value.split('#')[1]));
  return null;
}

/** The join page carries the bare ticket after #; older links carry invite=. */
const fromHash = (hash) => (hash.startsWith('tandem1') ? hash.replace(/\/$/, '') : new URLSearchParams(hash).get('invite'));

const ticketOf = (invite) => invite.slice('tandem://join/'.length);

/** The browser version, which joins at once. The invite stays after the #. */
const watchLink = (invite) => `${new URL('watch/', BASE).href}#${new URLSearchParams({ invite })}`;

/** On Android, Chrome opens the app from this, or the fallback when it is not installed. */
function intentLink(invite) {
  const fallback = encodeURIComponent(watchLink(invite));
  return `intent://join/${ticketOf(invite)}#Intent;scheme=tandem;package=${PACKAGE};S.browser_fallback_url=${fallback};end`;
}

/**
 * Tries the installed app, and if nothing takes over within a moment, opens the
 * browser version in this tab. Opening the app moves focus away from the page
 * or hides it, and so does the browser's own "Open Tandem?" question, so a
 * person still deciding is never sent elsewhere under them. On Android, Chrome
 * takes an intent link instead, which carries its own fallback.
 */
function enterRoom(invite, say) {
  if (ANDROID) {
    location.href = intentLink(invite);
    return;
  }
  let left = false;
  const away = () => { left = true; };
  const hidden = () => { if (document.hidden) left = true; };
  window.addEventListener('blur', away);
  window.addEventListener('pagehide', away);
  document.addEventListener('visibilitychange', hidden);
  say('Opening Tandem…');
  // Firefox shows an error page for a link nothing handles, so it gets a frame.
  if (/Firefox\//.test(navigator.userAgent)) {
    const frame = Object.assign(document.createElement('iframe'), { hidden: true, src: invite });
    document.body.append(frame);
    setTimeout(() => frame.remove(), APP_WAIT_MS * 2);
  } else {
    location.href = invite;
  }
  setTimeout(() => {
    window.removeEventListener('blur', away);
    window.removeEventListener('pagehide', away);
    document.removeEventListener('visibilitychange', hidden);
    if (left || !document.hasFocus()) {
      say('Opened in Tandem. If nothing happened, watch in this browser.');
      return;
    }
    say('Tandem is not on this computer, so the browser version is opening.');
    location.assign(watchLink(invite));
  }, APP_WAIT_MS);
}

/** Points the two ways in at this invite: the app, and the browser version. */
function offerWays(invite, say) {
  const app = $('join');
  app.href = ANDROID ? intentLink(invite) : invite;
  app.addEventListener('click', (e) => {
    e.preventDefault();
    enterRoom(invite, say);
  });
  $('watch').href = watchLink(invite);
  $('ways').hidden = false;
}

/** A trailer from the link may only be a web video file. */
function safeVideo(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' && /\.(mp4|webm)$/i.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

function showTicket(ticket) {
  for (const key of FIELDS) $(`t-${key}`).textContent = ticket[key] ?? '';
}

/** Small line glyphs for the setlist, drawn in the current colour. */
const GLYPHS = {
  sync: '<path d="M7 7v18M16 7v18M25 7v18"/><path class="g-move" d="M3 16h26"/>',
  clock: '<circle cx="16" cy="18" r="10"/><path d="M12 4h8"/><path class="g-move" d="M16 18v-6"/>',
  heart: '<path class="g-move" d="M16 26S5 19 5 12a5.5 5.5 0 0 1 11-1.5A5.5 5.5 0 0 1 27 12c0 7-11 14-11 14z"/>',
  bars: '<path d="M6 26V16M11 26V9M16 26V13M21 26V6M26 26V18"/>',
  down: '<path class="g-move" d="M16 4v15M10 13l6 6 6-6"/><path d="M5 27h22"/>',
  subs: '<rect x="4" y="7" width="24" height="18"/><path d="M8 16h6M17 16h7M8 21h10M21 21h3"/>',
  live: '<circle cx="16" cy="16" r="3"/><path class="g-move" d="M10 10a8.5 8.5 0 0 0 0 12M22 10a8.5 8.5 0 0 1 0 12M6 6a14 14 0 0 0 0 20M26 6a14 14 0 0 1 0 20"/>',
  screens: '<rect x="3" y="6" width="19" height="13"/><path d="M8 25h9M12.5 19v6"/><rect x="23" y="11" width="7" height="14"/>',
};

/** The setlist: numbered songs, each a feature with one true line and its glyph. */
function showcase(items) {
  const box = $('showcase');
  items.forEach((item, i) => {
    const song = Object.assign(document.createElement('li'), { className: 'song' });
    song.style.setProperty('--i', i);
    const number = Object.assign(document.createElement('span'), { className: 'song-n', textContent: String(i + 1).padStart(2, '0') });
    number.setAttribute('aria-hidden', 'true');
    const glyph = Object.assign(document.createElement('span'), { className: 'glyph' });
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = `<svg viewBox="0 0 32 32">${GLYPHS[item.glyph] ?? GLYPHS.sync}</svg>`;
    const words = document.createElement('div');
    words.append(Object.assign(document.createElement('h3'), { textContent: item.title }), Object.assign(document.createElement('p'), { textContent: item.text }));
    song.append(number, glyph, words);
    box.append(song);
  });
}

/** The facts, as call and response: the crowd's chant, then Tandem's plain answer. */
function facts(list) {
  list.forEach(([name, text], i) => {
    const row = Object.assign(document.createElement('li'), { className: `chant c${i % 4}` });
    row.dataset.lit = '';
    row.append(
      Object.assign(document.createElement('h3'), { className: 'call', textContent: `${name}!` }),
      Object.assign(document.createElement('p'), { className: 'answer', textContent: text }),
    );
    $('facts').append(row);
  });
}

function downloads({ note, links }) {
  $('get-note').textContent = note ?? '';
  for (const { label, url } of links ?? []) {
    $('get-links').append(Object.assign(document.createElement('a'), { className: 'btn', textContent: label, href: new URL(url, BASE).href }));
  }
}

function maker(ticket) {
  const form = $('maker');
  const note = $('maker-note');
  for (const name of ['show', 'date', 'time', 'seat']) form.elements[name].value = ticket[name] ?? '';
  const link = () => {
    const data = new FormData(form);
    const out = new URLSearchParams();
    for (const name of ['show', 'date', 'time', 'seat']) if (data.get(name)) out.set(name, data.get(name));
    const invite = inviteFrom(data.get('invite'));
    if (invite) out.set('invite', invite);
    return { url: `${location.origin}${location.pathname}#${out}`, invite, typed: !!String(data.get('invite')).trim() };
  };
  const refresh = () => {
    const { url, invite, typed } = link();
    $('preview').href = url;
    note.textContent = typed && !invite ? 'That is not a Tandem invite. Copy a new one from a room.' : invite ? 'Anyone with this link can join your room, so share it like a password.' : '';
  };
  form.addEventListener('input', refresh);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { url } = link();
    try { await navigator.clipboard.writeText(url); note.textContent = 'Pass link copied.'; }
    catch { note.textContent = url; }
  });
  $('preview').addEventListener('click', () => setTimeout(() => location.reload(), 0));
  refresh();
}

/**
 * The main stage. Until config.json lists the music video in trailer.sources,
 * it is a premiere card. With a source it becomes a player again: the video and
 * its poster load only when the screen comes near, so the first visit stays light.
 */
function stage(trailer) {
  const sources = (trailer.sources ?? []).filter((s) => s?.src);
  if (!sources.length) return null;
  const video = $('trailer');
  $('premiere').hidden = true;
  video.hidden = false;
  if (trailer.title) $('stage-title').textContent = trailer.title;
  if (trailer.note) $('stage-note').textContent = trailer.note;
  if (trailer.shape) video.style.aspectRatio = trailer.shape;
  const load = () => {
    if (video.dataset.loaded) return;
    video.dataset.loaded = '1';
    if (trailer.poster) video.poster = trailer.poster;
    for (const { src, type } of sources) {
      const source = document.createElement('source');
      source.src = src;
      if (type) source.type = type;
      video.append(source);
    }
    video.load();
  };
  if ('IntersectionObserver' in window) {
    const near = new IntersectionObserver((seen) => {
      if (seen.some((s) => s.isIntersecting)) { load(); near.disconnect(); }
    }, { rootMargin: '150px 0px' });
    near.observe(video);
  } else {
    load();
  }
  return load;
}

/**
 * Entering tears the stub off along the perforation. The pass keeps a ragged
 * edge, and the stub, cut along the same line, falls away. With reduced motion
 * the stub is simply gone.
 */
function tear() {
  const ticket = $('ticket');
  if (ticket.classList.contains('admitted')) return;
  ticket.classList.add('admitted');
  const stub = ticket.querySelector('.pass-stub');
  const w = ticket.offsetWidth, h = ticket.offsetHeight, C = 18;
  // Side by side, the perforation runs down the stub's left edge; stacked, across its top.
  const across = stub.offsetLeft > 0;
  const at = across ? stub.offsetLeft : stub.offsetTop;
  const len = across ? h : w;
  let seed = 7;
  const edge = [];
  for (let t = 0; t < len; t += 7) {
    seed = (seed * 9301 + 49297) % 233280;
    const d = (seed / 233280 - 0.5) * 8;
    edge.push(across ? `${at + d}px ${t}px` : `${t}px ${at + d}px`);
  }
  edge.push(across ? `${at}px ${h}px` : `${w}px ${at}px`);
  const back = [...edge].reverse();
  const keep = across
    ? `polygon(0 0, ${edge.join(', ')}, ${C}px ${h}px, 0 ${h - C}px)`
    : `polygon(0 0, ${w - C}px 0, ${w}px ${C}px, ${back.join(', ')})`;
  const gone = across
    ? `polygon(${edge.join(', ')}, ${w}px ${h}px, ${w}px ${C}px, ${w - C}px 0)`
    : `polygon(${edge.join(', ')}, ${w}px ${h}px, ${C}px ${h}px, 0 ${h - C}px)`;
  const piece = ticket.cloneNode(true);
  piece.removeAttribute('id');
  piece.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
  piece.setAttribute('aria-hidden', 'true');
  piece.inert = true;
  piece.classList.add('torn-stub');
  const base = getComputedStyle(ticket).transform;
  const t0 = base === 'none' ? 'translate(0, 0)' : base;
  Object.assign(piece.style, {
    left: `${ticket.offsetLeft}px`, top: `${ticket.offsetTop}px`, width: `${w}px`, height: `${h}px`,
    clipPath: gone, transformOrigin: across ? `${at}px 0` : `0 ${at}px`,
  });
  piece.style.setProperty('--peel0', t0);
  piece.style.setProperty('--peel1', `${t0} rotate(${across ? 5 : -4}deg) translate(4px, 2px)`);
  piece.style.setProperty('--peel2', `${t0} translate(${across ? 60 : 12}px, 70vh) rotate(${across ? 22 : -14}deg)`);
  ticket.style.clipPath = keep;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  piece.addEventListener('animationend', () => piece.remove(), { once: true });
  ticket.after(piece);
}

/**
 * Without an invite (and no live screening), the pass leads to the main stage: the video plays if there
 * is one, and otherwise the premiere's "Play the anthem" waits for a press.
 */
function enter(loadTrailer) {
  tear();
  $('stage').scrollIntoView({ block: 'center' });
  if (!loadTrailer) {
    document.querySelector('#premiere [data-sound]')?.focus({ preventScroll: true });
    return;
  }
  loadTrailer();
  const video = $('trailer');
  video.focus({ preventScroll: true });
  video.play().catch(() => {});
}

async function config() {
  return (await fetch(new URL('config.json', BASE), { cache: 'no-cache' })).json();
}

const say = (text) => { $('ways-status').textContent = text; };

async function start() {
  const programme = await config();
  const link = new URLSearchParams(location.hash.slice(1));
  const ticket = { ...programme.ticket };
  for (const key of FIELDS) if (link.get(key)) ticket[key] = link.get(key).slice(0, 80);
  const trailer = { ...programme.trailer };
  const fromLink = safeVideo(link.get('trailer'));
  if (fromLink) Object.assign(trailer, { sources: [{ src: fromLink }], poster: '', shape: '' });
  // No invite in the link: the pass is a seat in the live screening room.
  const invite = inviteFrom(link.get('invite')) ?? inviteFrom(programme.screening?.invite);

  showTicket(ticket);
  showcase(programme.showcase ?? []);
  facts(programme.facts ?? []);
  downloads(programme.download ?? {});
  maker(ticket);
  const loadTrailer = stage(trailer);
  // The pass is one big button: a click anywhere on it does what its button does.
  $('ticket').addEventListener('click', (e) => {
    if (!e.target.closest('a, button')) $('tear').click();
  });
  if (invite) {
    // A pass with an invite is a way into that room, so entering goes in.
    offerWays(invite, say);
    $('tear').textContent = 'Enter the room';
    $('tear').addEventListener('click', () => {
      tear();
      enterRoom(invite, say);
    });
  } else {
    $('tear').addEventListener('click', () => enter(loadTrailer));
  }
  // The rest of the show (lights, sound, the pass's code) picks up from here.
  window.tandem = { ticket, invite, anthem: programme.anthem ?? null, credits: programme.credits ?? null };
  document.dispatchEvent(new CustomEvent('tandem:ready'));
}

start().catch(() => {
  $('t-show').textContent = 'Tandem';
  $('t-line').textContent = 'The programme did not load. Refresh to try again.';
});
