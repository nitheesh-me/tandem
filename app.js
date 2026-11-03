// Fills the page from config.json. A ticket link overrides the ticket through the
// part of the address after #, which browsers never send to a server, so a room
// invite in a link stays between the people who have it.
//
// The same script runs the join page, join/#<ticket>, which is what the app's
// Copy invite gives. It opens the app if it is installed and otherwise the
// browser version, and the ticket never leaves the address's # part.
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

function showcase(items) {
  const box = $('showcase');
  for (const item of items) {
    const card = document.createElement('figure');
    card.className = `show cut${item.tall ? ' tall' : ''}`;
    card.style.margin = 0;
    const img = Object.assign(document.createElement('img'), { src: item.image, alt: item.title, loading: 'lazy' });
    const title = Object.assign(document.createElement('h3'), { textContent: item.title });
    const text = Object.assign(document.createElement('p'), { textContent: item.text });
    card.append(img, title, text);
    box.append(card);
  }
}

function facts(list) {
  for (const [name, text] of list) {
    const box = document.createElement('div');
    box.append(Object.assign(document.createElement('b'), { textContent: name, className: 'split' }), Object.assign(document.createElement('p'), { textContent: text }));
    $('facts').append(box);
  }
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
    try { await navigator.clipboard.writeText(url); note.textContent = 'Ticket link copied.'; }
    catch { note.textContent = url; }
  });
  $('preview').addEventListener('click', () => setTimeout(() => location.reload(), 0));
  refresh();
}

function enter(trailer) {
  $('ticket').classList.add('torn');
  $('theatre').hidden = false;
  const video = $('trailer');
  if (!video.src) {
    video.src = trailer.src;
    video.poster = trailer.poster ?? '';
    video.style.aspectRatio = trailer.shape ?? '';
  }
  video.addEventListener('play', () => window.contour?.pause(true));
  for (const name of ['pause', 'ended']) video.addEventListener(name, () => window.contour?.pause(false));
  $('theatre').scrollIntoView({ block: 'center' });
  video.focus();
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
  if (fromLink) Object.assign(trailer, { src: fromLink, poster: '', shape: '' });
  const invite = inviteFrom(link.get('invite'));

  showTicket(ticket);
  showcase(programme.showcase ?? []);
  facts(programme.facts ?? []);
  downloads(programme.download ?? {});
  maker(ticket);
  if (invite) {
    // A ticket with an invite is a way into that room, so tearing it goes in.
    offerWays(invite, say);
    $('tear').addEventListener('click', () => {
      $('ticket').classList.add('torn');
      enterRoom(invite, say);
    });
  } else {
    $('tear').addEventListener('click', () => enter(trailer));
  }
}

/** The join page: one invite, the two ways in, and the downloads. */
async function startJoin() {
  const invite = inviteFrom(fromHash(location.hash.slice(1)) ?? '');
  if (invite) {
    offerWays(invite, say);
  } else {
    $('j-title').textContent = 'This invite is not complete';
    say('Ask for a new invite, or copy the whole link again.');
  }
  try { downloads((await config()).download ?? {}); } catch { /* the ways in above still work */ }
}

if (document.body.dataset.page === 'join') {
  startJoin();
} else {
  start().catch(() => {
    $('t-show').textContent = 'Tandem';
    $('t-line').textContent = 'The programme did not load. Refresh to try again.';
  });
}
