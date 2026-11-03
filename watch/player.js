// The page owns only the <video>. Everything else is in the Station Worker, and
// the steering below follows `ui/src/lib/Player.svelte`. Facts for the test and
// the page itself live on `window.tandem`.
const video = document.getElementById('video');
const $ = (id) => document.getElementById(id);
// The invite rides after the #, which the browser never sends to any server.
const params = new URLSearchParams(location.hash.slice(1));
const facts = { events: [], stalls: 0, seeksApplied: 0, directives: 0, sw: null };
window.tandem = facts;
const note = (text, extra) => facts.events.push({ at: Date.now(), text, ...extra });

const worker = new Worker('station.worker.js', { type: 'module' });
navigator.serviceWorker.addEventListener('message', ({ data }) => { facts.sw = data; });

let seeking = false;
let buffering = false;
let wantPlay = false;
let starting = false;
let lastRateWrite = 0;
let lastPos = 0;
let mediaId = null;
let room = null;

// Media Source playback of a native Station's converted stream. `liveStart` is
// the film position at the stream's first frame, as `compatStart` is in the UI.
const LIVE_TYPE = 'video/mp4; codecs="avc1.64001e,mp4a.40.2"';
const LIVE_WIDTH = 640;
const LIVE_AHEAD_S = 15;
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
    const [t0, p0] = speedLog[0];
    speedNow = (at - p0) / (now - t0);
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
        video.muted = true;
        note('muted by the browser');
        await video.play().catch(() => {});
      }
    } finally {
      starting = false;
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

function show(id) {
  if (id === mediaId) return;
  mediaId = id;
  video.src = `media/${id}`;
  video.load();
  note('source set');
}

worker.onmessage = ({ data }) => {
  switch (data.t) {
    case 'joined':
      facts.me = data.me;
      facts.inWorker = data.inWorker;
      $('status').textContent = 'Joining the room...';
      break;
    case 'view': {
      room = data.view;
      facts.view = data.view;
      facts.links = data.links;
      facts.swarm = data.film;
      const names = room.stations.map((s) => s.name).join(', ');
      $('status').textContent = room.joined ? 'In the room' : 'Joining the room...';
      $('room').textContent = room.state.name ?? '';
      $('stations').textContent = names;
      const got = data.film?.have && data.film?.total ? ` · ${Math.round((data.film.have / data.film.total) * 100)}% here` : '';
      $('film').textContent = (room.state.items?.find((i) => i.id === room.state.timeline.item)?.name ?? '') + got;
      $('stage-note').hidden = !!video.src;
      break;
    }
    case 'film':
      facts.film = data;
      show(data.id);
      break;
    case 'live-film':
      facts.liveFilm = data;
      mediaId = data.id;
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
    case 'tick': sample(); break;
    case 'lag': facts.workerLag = data.ms; break;
    case 'directive': apply(data.d); break;
    case 'miss': note('read waits for a chunk', { index: data.index }); break;
    case 'error':
      facts.error = data.text;
      $('status').textContent = `Could not join: ${data.text}`;
      $('join').hidden = false;
      break;
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
video.addEventListener('playing', () => { buffering = false; });
video.addEventListener('canplay', () => { buffering = false; seeking = false; });
video.addEventListener('loadedmetadata', () => { seeking = false; note('metadata', { duration: video.duration }); });
video.addEventListener('error', () => {
  facts.videoError = video.error?.message ?? String(video.error?.code);
  note('video error', { message: facts.videoError });
});
window.addEventListener('pagehide', () => worker.postMessage({ t: 'bye' }));

$('join').onclick = async () => {
  $('join').hidden = true;
  try { localStorage.setItem('tandem-name', $('name').value); } catch { /* fine */ }
  await serviceWorkerReady();
  $('status').textContent = 'Connecting...';
  const window_ = Number(params.get('window') ?? 0);
  worker.postMessage({
    t: 'join', invite: $('invite').value, name: $('name').value, key: stationKey(),
    window: window_, noBuckets: params.has('nobuckets'),
    // For tests only: the receive window in KiB, where 0 means QUIC's defaults.
    windowKb: params.has('windowkb') ? Number(params.get('windowkb')) : undefined,
    forget: (params.get('forget') ?? '').split(',').filter(Boolean).map(Number),
  });
};
try { $('name').value = localStorage.getItem('tandem-name') || 'Guest'; } catch { $('name').value = 'Guest'; }
const sound = () => { $('unmute').hidden = !(video.muted && !video.paused); };
video.addEventListener('volumechange', sound);
video.addEventListener('playing', sound);
$('unmute').onclick = () => { video.muted = false; sound(); };
if (params.has('invite')) { $('invite').value = params.get('invite'); $('join').click(); }
else $('join').hidden = false;
