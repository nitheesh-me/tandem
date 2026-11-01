// Fills the page from config.json. A ticket link overrides the ticket through the
// part of the address after #, which browsers never send to a server, so a room
// invite in a link stays between the people who have it.
const $ = (id) => document.getElementById(id);
const INVITE = /^tandem:\/\/join\/tandem1[a-z2-7]+\/?$/;
const TICKET = /^tandem1[a-z2-7]+$/;
const FIELDS = ['show', 'line', 'venue', 'date', 'time', 'seat', 'admit'];

/** Only a real Tandem invite may become a link. Anything else in an address is ignored. */
function inviteFrom(text) {
  const value = (text ?? '').trim();
  if (INVITE.test(value)) return value;
  if (TICKET.test(value)) return `tandem://join/${value}`;
  return null;
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
    $('get-links').append(Object.assign(document.createElement('a'), { className: 'btn', textContent: label, href: url }));
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

async function start() {
  const config = await (await fetch('config.json', { cache: 'no-cache' })).json();
  const link = new URLSearchParams(location.hash.slice(1));
  const ticket = { ...config.ticket };
  for (const key of FIELDS) if (link.get(key)) ticket[key] = link.get(key).slice(0, 80);
  const trailer = { ...config.trailer };
  const fromLink = safeVideo(link.get('trailer'));
  if (fromLink) Object.assign(trailer, { src: fromLink, poster: '', shape: '' });
  const invite = inviteFrom(link.get('invite'));

  showTicket(ticket);
  showcase(config.showcase ?? []);
  facts(config.facts ?? []);
  downloads(config.download ?? {});
  maker(ticket);
  $('tear').addEventListener('click', () => enter(trailer));
  if (invite) {
    $('join').href = invite;
    $('join').hidden = false;
  }
}

start().catch(() => {
  $('t-show').textContent = 'Tandem';
  $('t-line').textContent = 'The programme did not load. Refresh to try again.';
});
