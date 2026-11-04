// The browser version of Tandem. The page owns the <video> and what you see;
// everything else is in the Station Worker, and the steering below follows
// `ui/src/lib/Player.svelte`. Facts for tests and the page live on `window.tandem`.
import { ticketFrom, fromHash, readTicket, appLink, joinLink, config } from '../invite.js';

const video = document.getElementById('video');
const $ = (id) => document.getElementById(id);
// The invite rides after the #, which the browser never sends to any server.
const params = new URLSearchParams(location.hash.slice(1));
const facts = { events: [], stalls: 0, seeksApplied: 0, directives: 0, sw: null, stages: {} };
window.tandem = facts;
const t0 = performance.now();
const note = (text, extra) => facts.events.push({ at: Date.now(), text, ...extra });
const mark = (stage) => { if (!(stage in facts.stages)) facts.stages[stage] = Math.round(performance.now() - t0); };

const worker = new Worker('station.worker.js', { type: 'module' });
navigator.serviceWorker?.addEventListener('message', ({ data }) => { facts.sw = data; });

let seeking = false;
let buffering = false;
let wantPlay = false;
let starting = false;
let lastRateWrite = 0;
let lastPos = 0;
let mediaId = null;
let room = null;
let joinedAt = 0;
let failed = false;
let programme = {};
let ticket = null;
const swReady = serviceWorkerReady().catch((e) => { facts.swError = String(e); });

// Media Source playback of a native Station's converted stream. `liveStart` is
// the film position at the stream's first frame, as `compatStart` is in the UI.
const LIVE_TYPE = 'video/mp4; codecs="avc1.64001e,mp4a.40.2"';
const LIVE_WIDTH = 640;
const LIVE_AHEAD_S = 15;
// After this long without the room answering, say so, and keep trying.
const ROOM_PATIENCE_MS = 25_000;
let live = null;
let liveStart = 0;
const positionNow = () => liveStart + video.currentTime;

/** A stable identity, so a reload is the same Station coming back. */
function stationKey() {
  let saved = null;
  try { saved = localStorage.getItem('tandem-key'); } catch { /* a new identity will do */ }
  if (saved) return Uint8Array.from(saved.match(/../g), (h) => parseInt(h, 16));
  const key = crypto.getRandomValues(new Uint8Array(32));
  try { localStorage.setItem('tandem-key', Array.from(key, (b) => b.toString(16).padStart(2, '0')).join('')); } catch { /* same */ }
  return key;
}

// True speed: media seconds per wall second over the last few seconds.
let speedLog = [];
let speedNow = 0;
function measureSpeed(at) {
  const now = performance.now() / 1000;
  const last = speedLog.at(-1);
  const jumped = last && Math.abs(at - last[1] - (now - last[0]) * video.playbackRate) > 0.5;
  if (video.paused || seeking || buffering || jumped) {
    speedLog = [];
    if (video.paused) speedNow = 0;
  }
  speedLog.push([now, at]);
  if (speedLog.length > 16) speedLog.shift();
  if (speedLog.length >= 6) {
    const [t0_, p0] = speedLog[0];
    speedNow = (at - p0) / (now - t0_);
  }
  return speedNow;
}

async function run(play) {
  wantPlay = play;
  if (play && video.paused && !starting) {
    starting = true;
    try {
      await video.play();
    } catch (e) {
      if (e.name === 'NotAllowedError' && !video.muted) {
        // Autoplay rules: start without sound, and offer sound on the picture.
        video.muted = true;
        facts.autoMuted = true;
        note('muted by the browser');
        await video.play().catch(() => {});
      }
    } finally {
      starting = false;
      soundUi();
    }
  } else if (!play && !video.paused) video.pause();
}

function apply(d) {
  facts.directives++;
  facts.lastDirective = d;
  if (!video.src) return;
  const wanted = Math.round(Math.min(4, Math.max(0.25, d.rate)) * 100) / 100;
  const settling = wanted === room?.state.timeline.rate;
  const now = performance.now();
  if (Math.abs(video.playbackRate - wanted) >= 0.01 && (settling || now - lastRateWrite > 1000)) {
    video.playbackRate = wanted;
    lastRateWrite = now;
  }
  if (d.seek !== null) {
    facts.seeksApplied++;
    if (live) {
      if (Math.abs(d.seek - positionNow()) > 0.25) beginLive(Math.max(0, d.seek));
    } else {
      seeking = true;
      video.currentTime = Math.max(0, d.seek);
    }
  }
  run(d.play);
}

/** Runs on the Worker's beat, because this page's own timers stop when hidden. */
function sample() {
  if (!video.src) return worker.postMessage({ t: 'gone' });
  if (live) pumpLive();
  const pos = positionNow();
  const moved = Math.abs(pos - lastPos) > 0.02;
  if (buffering && !video.paused && !seeking && moved) buffering = false;
  lastPos = pos;
  worker.postMessage({
    t: 'sample', pos, playing: !video.paused, buffering, seeking,
    speed: measureSpeed(pos), duration: Number.isFinite(video.duration) ? video.duration : 0,
  });
}

async function serviceWorkerReady() {
  if (!navigator.serviceWorker) throw new Error('no service worker');
  await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  }
}

function beginLive(start) {
  const ms = new MediaSource();
  const stream = { ms, sb: null, queue: [], generation: null, ended: false, owed: false };
  live = stream;
  liveStart = start;
  facts.liveStart = start;
  seeking = true;
  facts.liveStarts = (facts.liveStarts ?? 0) + 1;
  video.src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', () => {
    stream.sb = ms.addSourceBuffer(LIVE_TYPE);
    stream.sb.addEventListener('updateend', pumpLive);
    worker.postMessage({ t: 'live-go', start, width: LIVE_WIDTH });
  }, { once: true });
}

const liveAhead = () => {
  const b = video.buffered;
  return b.length ? b.end(b.length - 1) - video.currentTime : 0;
};

function pumpLive() {
  const { sb, queue, ms, ended } = live;
  if (!sb || sb.updating || ms.readyState !== 'open') return;
  if (queue.length) { sb.appendBuffer(queue.shift()); return; }
  if (ended) { ms.endOfStream(); return; }
  // Keep the picture's memory bounded behind the playhead as well.
  if (video.currentTime > 60 && sb.buffered.length && sb.buffered.start(0) < video.currentTime - 45) {
    sb.remove(0, video.currentTime - 30);
    return;
  }
  if (live.owed && liveAhead() < LIVE_AHEAD_S) {
    live.owed = false;
    worker.postMessage({ t: 'live-more' });
  }
}

async function show(id) {
  if (id === mediaId) return;
  mediaId = id;
  // Film bytes reach the <video> through the Service Worker, so it must be in charge first.
  await swReady;
  video.src = `media/${id}`;
  video.load();
  note('source set');
}

// ---------- What you see ----------

const STEPS = ['station', 'relay', 'room', 'picture', 'sync'];
let stepNow = 'station';
const step = (name) => document.querySelector(`.step[data-step="${name}"]`);
function setStep(name, what, p) {
  const at = STEPS.indexOf(name);
  if (at >= STEPS.indexOf(stepNow)) {
    stepNow = name;
    STEPS.forEach((s, i) => {
      const el = step(s);
      if (el.dataset.state === 'fail') return;
      el.dataset.state = i < at ? 'done' : i === at ? 'now' : 'wait';
      if (i < at && el.dataset.doneText) el.querySelector('.what').textContent = el.dataset.doneText;
    });
    mark(name);
  }
  if (what != null) step(name).querySelector('.what').textContent = what;
  if (p != null) step(name).style.setProperty('--p', Math.max(0, Math.min(1, p)));
}
const doneText = (name, text) => { step(name).dataset.doneText = text; if (step(name).dataset.state === 'done') step(name).querySelector('.what').textContent = text; };

function chip(text, tone) {
  $('state-text').textContent = text;
  $('state-chip').dataset.tone = tone;
  $('state-chip').classList.toggle('live', tone === 'green');
}

function boot(open, { label, title, sub, tone } = {}) {
  $('boot').hidden = !open;
  if (label != null) $('boot-label').textContent = label;
  if (title != null) $('boot-title').textContent = title;
  if (sub != null) $('boot-sub').textContent = sub;
  $('boot').dataset.tone = tone ?? '';
}

function fail(title, sub, stepName) {
  failed = true;
  if (stepName) {
    step(stepName).dataset.state = 'fail';
    step(stepName).querySelector('.what').textContent = 'Failed';
  }
  boot(true, { label: '// Signal lost', title, sub, tone: 'pink' });
  chip('Not connected', 'pink');
  $('retry').hidden = false;
  $('boot-back').hidden = false;
  $('retry').focus();
}

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
const clock = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const ss = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
const msText = (us) => (us == null || us <= 0 ? 'Not measured' : `${Math.round(us / 1000)} ms`);

const CLOCK = { Reference: ['Room clock', 'yellow'], Locked: ['Locked', 'green'], Acquiring: ['Syncing', 'violet'], Degraded: ['Unsteady', 'pink'], Unsynced: ['Not synced', 'muted'] };

function soundUi() {
  const off = video.muted || video.volume === 0;
  $('sound').setAttribute('aria-pressed', String(off));
  $('sound-name').textContent = off ? 'Turn sound on' : 'Turn sound off';
  $('sound').title = `${off ? 'Turn sound on' : 'Turn sound off'} (M)`;
  $('sound-wave').style.display = off ? 'none' : '';
  $('sound-x').style.display = off ? '' : 'none';
  $('unmute').hidden = !(off && !video.paused && $('boot').hidden);
}

function fullUi() {
  const on = !!document.fullscreenElement;
  $('full-name').textContent = on ? 'Leave fullscreen' : 'Fullscreen';
  $('full').title = `${on ? 'Leave fullscreen' : 'Fullscreen'} (F)`;
}

function bar() {
  const pos = positionNow();
  const dur = Number.isFinite(video.duration) ? video.duration + liveStart : (room?.state.items?.find((i) => i.id === room.state.timeline.item)?.duration_ms ?? 0) / 1000;
  $('t-now').textContent = clock(pos);
  $('t-total').textContent = clock(dur);
  const b = video.buffered;
  let ahead = 0;
  for (let i = 0; i < b.length; i++) if (b.start(i) <= video.currentTime + 0.5 && b.end(i) > video.currentTime) ahead = b.end(i) - video.currentTime;
  facts.aheadS = ahead;
  const frac = dur ? pos / dur : 0;
  $('t-played').style.width = `${frac * 100}%`;
  $('t-ahead').style.width = `${dur ? Math.min(1, (pos + ahead) / dur) * 100 : 0}%`;
  $('track').setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  $('track').setAttribute('aria-valuetext', `${clock(pos)} of ${clock(dur)}`);
  $('f-ahead').textContent = `${ahead.toFixed(1)} s`;
  return ahead;
}

function people(view) {
  const list = $('people');
  const rows = view.stations.map((s) => {
    const li = Object.assign(document.createElement('li'), { className: 'person' });
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: s.name || 'A Station' });
    if (s.is_you) name.append(Object.assign(document.createElement('span'), { className: 'you', textContent: ' (you)' }));
    li.append(name);
    const tag = (text, tone, solid) => {
      const c = Object.assign(document.createElement('span'), { className: `chip${solid ? ' solid' : ''}`, textContent: text });
      c.dataset.tone = tone;
      li.append(c);
    };
    if (s.is_master) tag('Master', 'yellow', true);
    if (!s.online && !s.is_you) tag('Away', 'muted');
    else if (s.buffering) tag('Buffering', 'yellow');
    return li;
  });
  list.replaceChildren(...rows);
  const others = view.audience ?? 0;
  $('audience').textContent = view.observer || others
    ? `${others} watching along as observers, including you.`
    : '';
}

function syncUi(view) {
  const d = facts.lastDirective;
  const big = $('sync-big');
  const playing = !video.paused && video.readyState >= 2;
  if (!d || !video.src || !playing) {
    big.textContent = video.src ? 'Waiting for the picture' : 'Not measured yet';
    big.dataset.tone = 'muted';
  } else {
    const ms = Math.abs(d.error * 1000);
    big.innerHTML = '';
    big.append(`${ms < 10 ? ms.toFixed(1) : Math.round(ms)}`, Object.assign(document.createElement('small'), { textContent: 'ms off' }));
    big.dataset.tone = ms <= 40 ? 'green' : ms <= 150 ? 'yellow' : 'pink';
  }
  const [cText] = CLOCK[view.clock?.quality] ?? ['Not synced'];
  $('f-clock').textContent = cText;
  $('f-rtt').textContent = msText(view.clock?.rtt_us);
  if (failed) return;
  if (!view.joined) return;
  if (buffering || (wantPlay && !playing && video.src)) chip('Buffering', 'yellow');
  else if (!view.state.timeline.playing) chip('Paused by the room', 'muted');
  else if (d?.inSync) chip('In sync', 'green');
  else if (playing) chip('Catching up', 'yellow');
  else chip('No picture yet', 'muted');
}

let lastView = 0;
function onView(data) {
  room = data.view;
  facts.view = data.view;
  facts.links = data.links;
  facts.swarm = data.film;
  const view = room;
  const item = view.state.items?.find((i) => i.id === view.state.timeline.item);
  const name = view.state.name || (ticket && ticket === ticketFrom(programme.screening?.invite) ? programme.screening?.name : '') || 'A Tandem room';
  if ($('room').textContent !== name) {
    $('room').textContent = name;
    document.title = `${name}: Tandem in your browser`;
  }
  // An observer watches along: the screening's host steers, and says so here.
  const observer = !!view.observer;
  $('role-chip').hidden = !view.joined;
  $('role-chip').textContent = observer ? 'Observer' : 'Guest';
  $('kicker').textContent = observer ? '// Now screening' : '// Now showing';
  $('steer').textContent = observer
    ? 'This is a screening, so the host steers play, pause and seeking for everyone. Sound and fullscreen are yours.'
    : 'Play, pause and seeking follow the room. To steer, open this room in the Tandem app.';
  $('f-film').textContent = item?.name ?? 'None yet';
  const f = data.film;
  if (f?.total) $('f-here').textContent = `${Math.round((f.have / f.total) * 100)}%`;
  const path = data.links?.flatMap((l) => l.paths).find((p) => p.selected);
  $('f-path').textContent = path ? `${path.relay ? 'Relay' : 'Direct'}, ${Math.round(path.rtt_ms)} ms` : 'Not linked';
  if (path) {
    const host = /Relay\(https:\/\/([^/.]+)/.exec(path.remote)?.[1];
    doneText('relay', host ? `${host}` : 'Linked');
  }
  if (!view.joined) {
    setStep('room', view.stations.length > 1 ? 'Answered, asking to join' : 'Calling the room');
  } else {
    if (!joinedAt) { joinedAt = performance.now(); mark('joined'); }
    doneText('room', `${view.stations.length} Station${view.stations.length === 1 ? '' : 's'}`);
    if (!item) setStep('picture', 'Nothing is playing yet');
    else if (STEPS.indexOf(stepNow) < 3) setStep('picture', 'Opening the film');
  }
  people(view);
  const now = performance.now();
  if (now - lastView > 1000) {
    lastView = now;
    $('facts').textContent = JSON.stringify({ stages: facts.stages, film: facts.film && { kind: facts.film.kind, size: facts.film.size, kept: facts.film.kept }, swarm: f, clock: view.clock, links: data.links }, null, 1);
  }
}

/** The boot steps after joining, and the bar, on the Worker's beat. */
function progress() {
  const ahead = bar();
  if (!room?.joined) return;
  if (!video.src) return;
  const f = facts.swarm;
  const playing = !video.paused && video.readyState >= 3;
  if (!playing) {
    const got = f?.pulled_bytes ? `${mb(f.pulled_bytes)} in` : 'Asking for the film';
    setStep('picture', live ? `Converted stream, ${ahead.toFixed(1)} s ready` : `${got}, ${ahead.toFixed(1)} s ready`, Math.min(1, ahead / 4));
    return;
  }
  doneText('picture', `${ahead.toFixed(1)} s ready`);
  mark('first-frame');
  if (!facts.lastDirective?.inSync) {
    setStep('sync', `${Math.round(Math.abs((facts.lastDirective?.error ?? 0) * 1000))} ms off`);
    // A film that plays but is still settling: the picture can show already.
    if (performance.now() - (facts.firstPlayAt ??= performance.now()) > 2500 && !$('boot').hidden && !failed) { boot(false); soundUi(); }
    return;
  }
  setStep('sync', 'Locked');
  mark('in-sync');
  if (!$('boot').hidden && !failed) {
    boot(false);
    soundUi();
  }
}

worker.onmessage = ({ data }) => {
  switch (data.t) {
    case 'wasm':
      setStep('station', data.total ? `${mb(data.got)} of ${mb(data.total)}` : mb(data.got), data.total ? data.got / data.total : 0.5);
      break;
    case 'wasm-ready':
      facts.wasm = data;
      doneText('station', `${mb(data.bytes)}, ${data.ms < 1000 ? `${data.ms} ms` : `${(data.ms / 1000).toFixed(1)} s`}${data.cached ? ', cached' : ''}`);
      if (facts.joining) setStep('relay', 'Finding the nearest relay');
      break;
    case 'joined':
      facts.me = data.me;
      facts.inWorker = data.inWorker;
      doneText('relay', 'Online');
      setStep('room', 'Calling the room');
      setTimeout(() => {
        if (!room?.joined && !failed) {
          boot(true, { label: '// Still calling', title: 'The room has not answered yet', sub: 'Its host may be offline, or the invite may be old. This page keeps trying. You can also ask for a fresh invite.' });
          chip('Waiting for the room', 'yellow');
          $('retry').hidden = false;
          $('boot-back').hidden = false;
        }
      }, ROOM_PATIENCE_MS);
      break;
    case 'view': onView(data); break;
    case 'film':
      facts.film = data;
      $('f-store').textContent = data.kind === 'bucket' ? 'Storage bucket' : data.kind === 'opfs' ? 'Private files' : data.kind;
      show(data.id);
      break;
    case 'live-film':
      facts.liveFilm = data;
      mediaId = data.id;
      $('f-store').textContent = 'Converted stream';
      beginLive(data.position);
      break;
    case 'live-started': live.generation = data.generation; break;
    case 'live-bytes':
      if (live?.generation !== data.generation) break;
      facts.liveBytes = data.total;
      live.queue.push(data.bytes);
      live.owed = true;
      pumpLive();
      break;
    case 'live-end':
      if (live?.generation === data.generation) { live.ended = true; pumpLive(); }
      break;
    case 'storage': facts.storageNow = data.facts; break;
    case 'tick': sample(); progress(); if (room) syncUi(room); break;
    case 'lag': facts.workerLag = data.ms; break;
    case 'directive': apply(data.d); break;
    case 'miss': note('read waits for a chunk', { index: data.index }); break;
    case 'error': {
      facts.error = data.text;
      const t = String(data.text);
      if (/relay/i.test(t)) fail('No relay answered', 'This browser could not reach any Tandem relay. Check the connection, then try again.', 'relay');
      else if (/ticket/i.test(t)) fail('This invite does not work', 'It could not be read. Ask the host for a fresh invite.', 'room');
      else if (/storage|quota/i.test(t)) fail('This browser would not store the film', `Private browsing or a full disk can do this. The browser said: ${t}`, 'picture');
      else if (/wasm|WebAssembly|compile/i.test(t)) fail('The Station did not load', 'The download may have been cut off. Try again.', 'station');
      else fail('Something stopped the Station', `The browser said: ${t}`, stepNow);
      break;
    }
    default: break;
  }
};

function bufferedSeconds() {
  const b = video.buffered;
  return Array.from({ length: b.length }, (_, i) => [+b.start(i).toFixed(1), +b.end(i).toFixed(1)]);
}
facts.buffered = bufferedSeconds;
facts.position = positionNow;
facts.askStorage = () => worker.postMessage({ t: 'storage' });

video.addEventListener('seeked', () => { seeking = false; });
video.addEventListener('waiting', () => { buffering = true; facts.stalls++; note('waiting', { pos: video.currentTime }); });
video.addEventListener('playing', () => { buffering = false; soundUi(); });
video.addEventListener('canplay', () => { buffering = false; seeking = false; });
video.addEventListener('loadedmetadata', () => { seeking = false; note('metadata', { duration: video.duration }); });
video.addEventListener('volumechange', soundUi);
video.addEventListener('error', () => {
  facts.videoError = video.error?.message ?? String(video.error?.code);
  note('video error', { message: facts.videoError });
  if (video.error?.code === 4) fail('This browser cannot play this film', 'Its format is not one browsers play. Open the room in the Tandem app, or ask the host for an MP4.', 'picture');
});
window.addEventListener('pagehide', () => worker.postMessage({ t: 'bye' }));

// Sound and size are this viewer's own.
$('sound').onclick = () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 1; soundUi(); };
$('unmute').onclick = () => { video.muted = false; soundUi(); $('sound').focus(); };
const stage = $('stage');
$('full').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    // iPhone Safari has fullscreen for the video element only.
    video.webkitEnterFullscreen?.();
  }
};
document.addEventListener('fullscreenchange', fullUi);
let idleTimer = 0;
const wake = () => { stage.classList.remove('idle'); clearTimeout(idleTimer); idleTimer = setTimeout(() => stage.classList.add('idle'), 2500); };
['pointermove', 'keydown', 'focusin'].forEach((e) => stage.addEventListener(e, wake));
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'f' || e.key === 'F') { e.preventDefault(); $('full').click(); }
  if (e.key === 'm' || e.key === 'M') { e.preventDefault(); $('sound').click(); }
});
$('retry').onclick = () => location.reload();

/** Starts the Station: the Worker has been loading the wasm since the page opened. */
function join(invite, name) {
  facts.joining = true;
  failed = false;
  $('form').hidden = true;
  $('join').hidden = true;
  $('screening').hidden = true;
  $('retry').hidden = true;
  $('boot-back').hidden = true;
  STEPS.forEach((s) => { step(s).hidden = false; });
  boot(true, { label: '// Boot sequence', title: 'Getting your seat ready', sub: 'This browser becomes a Tandem Station. It takes a few seconds the first time.' });
  chip('Connecting', 'violet');
  $('f-name').textContent = name;
  if (facts.wasm) setStep('relay', 'Finding the nearest relay');
  worker.postMessage({
    t: 'join', invite, name, key: stationKey(),
    window: Number(params.get('window') ?? 0), noBuckets: params.has('nobuckets'), small: params.has('small'),
    // For tests only: the receive window in KiB, where 0 means QUIC's defaults.
    windowKb: params.has('windowkb') ? Number(params.get('windowkb')) : undefined,
    forget: (params.get('forget') ?? '').split(',').filter(Boolean).map(Number),
  });
}

function savedName() {
  try { return localStorage.getItem('tandem-name') || 'Guest'; } catch { return 'Guest'; }
}

/** No usable invite: ask for one, and offer the live screening. */
function ask(problem) {
  boot(true, {
    label: problem ? '// Invite problem' : '// No invite',
    title: problem ? (problem === 'cut' ? 'This invite is cut short' : 'This is not a Tandem invite') : 'Which room?',
    sub: problem ? 'Paste the whole invite again, or ask the host for a new one.' : 'Paste a room invite to join it here, or watch the live screening.',
    tone: problem ? 'pink' : '',
  });
  chip(problem ? 'Invite problem' : 'No invite', problem ? 'pink' : 'muted');
  document.body.dataset.mode = 'ask';
  $('room').textContent = 'Watch in your browser';
  $('back').textContent = 'Back';
  STEPS.forEach((s) => { step(s).hidden = true; });
  $('form').hidden = false;
  $('join').hidden = false;
  $('name').value = savedName();
  config().then((c) => {
    programme = c;
    const t = ticketFrom(c.screening?.invite);
    if (!t) return;
    $('screening').textContent = c.screening.label ?? 'Watch the live screening';
    $('screening').href = `#${new URLSearchParams({ invite: appLink(t) })}`;
    $('screening').hidden = false;
  }).catch(() => {});
  $('invite').focus();
}

$('join').onclick = () => {
  const t = ticketFrom($('invite').value);
  const read = readTicket(t);
  if (!read.ok) {
    $('form-warn').textContent = t ? 'That invite is cut short. Copy the whole link again.' : 'That is not a Tandem invite. It starts with tandem1, or with this site\'s join link.';
    $('invite').focus();
    return;
  }
  try { localStorage.setItem('tandem-name', $('name').value.trim() || 'Guest'); } catch { /* fine */ }
  // The address keeps the invite, so a reload or a shared tab rejoins the same room.
  history.replaceState(null, '', `#${new URLSearchParams({ invite: appLink(t) })}`);
  location.reload();
};
$('form').addEventListener('submit', (e) => { e.preventDefault(); $('join').click(); });
window.addEventListener('hashchange', () => location.reload());

function start() {
  const raw = fromHash(location.hash);
  ticket = ticketFrom(raw);
  const read = readTicket(ticket);
  $('back').href = ticket ? joinLink(ticket) : '../join/';
  $('boot-back').href = $('back').href;
  if (!read.ok) {
    ask(String(raw ?? '').trim() ? read.why : null);
    if (raw) $('invite').value = raw;
    return;
  }
  worker.postMessage({ t: 'warm' });
  config().then((c) => { programme = c; }).catch(() => {});
  join(appLink(ticket), savedName());
}

if (!('Worker' in window) || !navigator.serviceWorker || !window.WebAssembly) {
  fail('This browser cannot run Tandem', 'It needs WebAssembly, Workers and a Service Worker. A current Chrome, Edge, Firefox or Safari has them. Private windows in some browsers turn them off.');
} else {
  start();
}
soundUi();
fullUi();
