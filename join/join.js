// The join page, join/#<ticket>, which is what the app's Copy invite gives.
// It reads the invite on this device, offers the app and the browser version,
// and says plainly when the app does not open.
import { ticketFrom, fromHash, readTicket, appLink, watchLink, joinLink, config } from '../invite.js';

const $ = (id) => document.getElementById(id);
const ANDROID = /Android/i.test(navigator.userAgent);
const PACKAGE = 'app.tandem.desktop';
// How long the app has to take over before the page says it did not.
const APP_WAIT_MS = 1600;

let programme = {};
const loaded = config().then((c) => { programme = c; }).catch(() => {});

function say(tone, label, text, actions = []) {
  const box = $('notice');
  box.replaceChildren();
  if (!label && !text) return;
  box.dataset.tone = tone;
  box.append(Object.assign(document.createElement('p'), { className: 'label', textContent: label }));
  if (text) box.append(Object.assign(document.createElement('p'), { textContent: text }));
  if (actions.length) {
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    row.append(...actions);
    box.append(row);
  }
}

const button = (text, href, cls = 'btn') => Object.assign(document.createElement('a'), { className: cls, textContent: text, href });

/** On Android, Chrome opens the app from this, or comes back here when it is not installed. */
function intentLink(ticket) {
  const fallback = encodeURIComponent(joinLink(ticket, '&noapp'));
  return `intent://join/${ticket}#Intent;scheme=tandem;package=${PACKAGE};S.browser_fallback_url=${fallback};end`;
}

/** What to say when the app did not take over: where to get it, and the way that works now. */
function appMissing(ticket) {
  const d = programme.download ?? {};
  const links = (d.links ?? []).map(({ label, url }) => button(label, new URL(url, new URL('../', location.href)).href));
  const watch = button('Watch in your browser', watchLink(ticket), 'btn primary');
  say('yellow', '// Tandem did not open',
    `Tandem does not seem to be installed here. ${links.length ? 'Get it below, or watch in this browser now.' : (d.note ? `${d.note} Until then, watch in this browser.` : 'Watch in this browser instead.')}`,
    [watch, ...links]);
  $('watch').classList.add('primary');
  $('join').classList.remove('primary');
  watch.focus();
}

/**
 * Tries the installed app. Opening it moves focus away from the page or hides
 * it, and so does the browser's own "Open Tandem?" question, so a person still
 * deciding is never told it failed under them.
 */
function openApp(ticket) {
  if (ANDROID) {
    location.href = intentLink(ticket);
    return;
  }
  let left = false;
  const away = () => { left = true; };
  const hidden = () => { if (document.hidden) left = true; };
  window.addEventListener('blur', away);
  window.addEventListener('pagehide', away);
  document.addEventListener('visibilitychange', hidden);
  say('cyan', '// Opening Tandem', 'Your browser may ask first. Say yes to open the room in the app.');
  // Firefox shows an error page for a link nothing handles, so it gets a frame.
  if (/Firefox\//.test(navigator.userAgent)) {
    const frame = Object.assign(document.createElement('iframe'), { hidden: true, src: appLink(ticket) });
    document.body.append(frame);
    setTimeout(() => frame.remove(), APP_WAIT_MS * 2);
  } else {
    location.href = appLink(ticket);
  }
  setTimeout(() => {
    window.removeEventListener('blur', away);
    window.removeEventListener('pagehide', away);
    document.removeEventListener('visibilitychange', hidden);
    if (left || !document.hasFocus()) {
      say('green', '// Opened in Tandem', 'The room is in the app now. If nothing happened, watch in this browser instead.');
      return;
    }
    appMissing(ticket);
  }, APP_WAIT_MS);
}

/** A strip from the invite's bytes, so each pass looks like its own. */
function drawCode(bytes) {
  const box = $('code');
  box.replaceChildren();
  const take = bytes ? bytes.subarray(0, 24) : new Uint8Array(24);
  for (const b of take) {
    for (const bit of [b >> 6, (b >> 3) & 7]) {
      box.append(Object.assign(document.createElement('i'), { className: bytes ? (bit > 5 ? 't' : bit < 2 ? 'g' : '') : 'g' }));
    }
  }
}

function setPass({ tone, kind, room, state, stations, serial, bytes }) {
  $('pass').dataset.tone = tone;
  $('pass-kind').textContent = kind;
  $('pass-room').textContent = room;
  $('pass-state').textContent = state;
  $('pass-stations').textContent = stations;
  $('serial').textContent = serial;
  drawCode(bytes);
}

async function screeningCard(show) {
  await loaded;
  const s = programme.screening;
  const ticket = ticketFrom(s?.invite);
  if (!ticket || !show) { $('screening').hidden = true; return; }
  $('screening-note').textContent = s.note ?? '';
  $('screening-go').textContent = s.label ?? 'Watch the live screening';
  $('screening-go').href = watchLink(ticket);
  $('screening').hidden = false;
}

async function render() {
  await loaded;
  const raw = fromHash(location.hash);
  const ticket = ticketFrom(raw);
  const read = readTicket(ticket);
  const screening = ticketFrom(programme.screening?.invite);
  const isScreening = read.ok && ticket === screening;
  const d = programme.download ?? {};
  $('get-note').textContent = d.note ?? '';
  const links = $('get-links');
  links.replaceChildren(...(d.links ?? []).map(({ label, url }) => button(label, new URL(url, new URL('../', location.href)).href)));
  say();
  $('watch').classList.remove('primary');
  $('join').classList.add('primary');

  $('main').dataset.state = read.ok ? 'ok' : 'problem';
  if (read.ok) {
    document.title = isScreening ? 'Tandem: the live screening' : 'Tandem: you are invited';
    $('kicker').textContent = isScreening ? '// Live screening' : '// Admission';
    $('kicker').dataset.tone = isScreening ? 'pink' : 'cyan';
    $('title').textContent = isScreening ? 'Take your seat.' : 'You have a seat.';
    $('lead').textContent = isScreening
      ? `${programme.screening?.note ?? ''} Everyone sees the same frame at the same moment.`.trim()
      : 'This is an invite to a Tandem room. Everyone in it sees the same frame at the same moment, wherever they are.';
    $('join').href = ANDROID ? intentLink(ticket) : appLink(ticket);
    $('watch').href = watchLink(ticket);
    $('ways').hidden = false;
    $('paste').hidden = true;
    setPass({
      tone: isScreening ? 'pink' : 'cyan', kind: isScreening ? 'Screening pass' : 'Room invite',
      // The ticket carries no room name, so only the screening, which this site knows, gets one.
      room: isScreening ? (programme.screening?.name ?? 'The public screening') : 'A private room',
      state: 'Complete', stations: String(read.stations), serial: `TDM ${ticket.slice(7, 19).toUpperCase()}`, bytes: read.bytes,
    });
    screeningCard(false);
    if (new URLSearchParams(location.hash.slice(1)).has('noapp')) appMissing(ticket);
    return;
  }

  $('ways').hidden = true;
  $('paste').hidden = false;
  const none = !String(raw ?? '').trim();
  $('kicker').dataset.tone = none ? 'yellow' : 'pink';
  if (none) {
    document.title = 'Tandem: no invite in this link';
    $('kicker').textContent = '// No invite';
    $('title').textContent = 'This link has no invite.';
    $('lead').textContent = 'A Tandem invite link ends with a long code after the #. Paste one below, or watch the live screening while you wait.';
  } else {
    document.title = 'Tandem: this invite does not work';
    $('kicker').textContent = '// Invite problem';
    $('title').textContent = read.why === 'cut' ? 'This invite is cut short.' : 'This is not a Tandem invite.';
    $('lead').textContent = read.why === 'cut'
      ? 'Part of the code is missing, so no room can be found with it. Some chat apps cut long links. Copy the whole link again, or ask the host for a new invite.'
      : 'The code after the # is not a room invite. Ask the host to copy the invite again from their room.';
  }
  setPass({ tone: none ? 'muted' : 'pink', kind: 'Room invite', room: none ? 'No room yet' : 'Unreadable invite', state: none ? 'Missing' : (read.why === 'cut' ? 'Cut short' : 'Not an invite'), stations: 'None', serial: 'TDM', bytes: null });
  screeningCard(true);
}

$('join').addEventListener('click', (e) => {
  const ticket = ticketFrom(fromHash(location.hash));
  if (!ticket || ANDROID) return;
  e.preventDefault();
  openApp(ticket);
});

$('paste').addEventListener('submit', (e) => {
  e.preventDefault();
  const ticket = ticketFrom($('paste-in').value);
  const read = readTicket(ticket);
  if (!read.ok) {
    $('paste-warn').textContent = ticket ? 'That invite is cut short. Copy the whole link again.' : 'That is not a Tandem invite. It starts with tandem1, or with this site\'s join link.';
    return;
  }
  $('paste-warn').textContent = '';
  location.hash = ticket;
  $('title').focus();
});

window.addEventListener('hashchange', render);
render();
