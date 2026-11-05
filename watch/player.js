// The browser version of Tandem. The page owns the <video> and what you see;
// everything else is in the Station Worker, and the steering below follows
// `ui/src/lib/Player.svelte`. Facts for tests and the page live on `window.tandem`.
import { ticketFrom, fromHash, readTicket, appLink, joinLink, config } from '../invite.js';
import { readSong, cueAt } from './song.js';

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

/** Milliseconds on a clock this page and its Worker share. */
const wallNow = () => performance.timeOrigin + performance.now();

function apply(d) {
  facts.directives++;
  facts.lastDirective = d;
  if (!video.src || holding()) return;
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
      // The seek was aimed at the moment the Worker decided it; the room has
      // moved on while the answer came back.
      const late = d.at ? Math.min(1, Math.max(0, (wallNow() - d.at) / 1000)) * (room?.state.timeline.rate ?? 1) : 0;
      seeking = true;
      video.currentTime = Math.max(0, d.seek + late);
    }
  }
  run(d.play);
}

/** Runs on the Worker's beat, because this page's own timers stop when hidden. */
function sample() {
  // While a seat is held for the next showing, this Station plays nothing: it
  // keeps its clock and its download, and steers that to the film's start.
  if (holding()) {
    worker.postMessage({ t: 'gone' });
    worker.postMessage({ t: 'steer', chunk: 0 });
    return;
  }
  if (!video.src) return worker.postMessage({ t: 'gone' });
  if (live) pumpLive();
  const pos = positionNow();
  const moved = Math.abs(pos - lastPos) > 0.02;
  if (buffering && !video.paused && !seeking && moved) buffering = false;
  lastPos = pos;
  worker.postMessage({
    t: 'sample', pos, playing: !video.paused, buffering, seeking,
    speed: measureSpeed(pos), duration: Number.isFinite(video.duration) ? video.duration : 0,
    // When it was taken, on a clock the Worker shares: a busy Worker can hold
    // a report for a while, and the player has moved on meanwhile.
    at: wallNow(), rate: video.playbackRate,
  });
}

async function serviceWorkerReady() {
  if (!navigator.serviceWorker) throw new Error('no service worker');
  const reg = await Promise.race([
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready),
    new Promise((ok) => setTimeout(ok, 8000)),
  ]);
  if (!reg) throw new Error('the Service Worker did not start');
  // A page can open without its Service Worker in charge (Firefox after a
  // return to this page, or a hard reload), and then the film's reads would
  // miss it: ask the worker to take this page over, and wait for it.
  if (!navigator.serviceWorker.controller) {
    note('asking the Service Worker to take over');
    const taken = new Promise((ok) => navigator.serviceWorker.addEventListener('controllerchange', ok, { once: true }));
    reg.active?.postMessage({ t: 'claim' });
    await Promise.race([taken, new Promise((ok) => setTimeout(ok, 5000))]);
    facts.swClaimed = !!navigator.serviceWorker.controller;
    if (!facts.swClaimed) throw new Error('the Service Worker would not take this page');
  }
}

function beginLive(start) {
  const ms = new MediaSource();
  const stream = { ms, sb: null, queue: [], generation: null, ended: false, owed: false };
  live = stream;
  songOff();
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

const TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime' };
/** A media type from a file name; MP4 when it does not say. */
const mediaType = (name) => TYPES[/\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase()] ?? 'video/mp4';

async function show(id, sid) {
  if (id === mediaId) return;
  mediaId = id;
  // Film bytes reach the <video> through the Service Worker, so it must be in charge first.
  await swReady;
  if (facts.swError) {
    fail('The picture could not start', 'This browser did not let the page use its Service Worker, which carries the film to the picture. Reload the page to try again.', 'picture');
    return;
  }
  songOff();
  // Every tab's Station hears the Service Worker, so the address names this one,
  // and the file's type, which the Service Worker answers with.
  const name = room?.state.items?.find((i) => i.id === id)?.name ?? '';
  const q = new URLSearchParams({ ...(sid ? { s: sid } : {}), type: mediaType(name) });
  video.src = `media/${id}?${q}`;
  video.load();
  note('source set');
}

// ---------- A song ----------
//
// Sound and no picture: the app's audio stage, from the song's own tags. The
// cover, the title (config.json's, else the tag's), the artist, and the timed
// lyrics follow the playhead, with the next line under the current one.

let song = null;
function songOff() {
  song?.abort.abort();
  if (song?.art) URL.revokeObjectURL(song.art);
  song = null;
  facts.song = null;
  $('song').hidden = true;
  $('song-art').removeAttribute('src');
}

async function songOn() {
  if (live || !video.src || video.videoWidth || song?.id === mediaId) return;
  songOff();
  const id = mediaId;
  const item = room?.state.items?.find((i) => i.id === id);
  song = { id, abort: new AbortController(), cues: null, shown: null };
  facts.song = { id, name: item?.name ?? null, tags: 'reading' };
  $('song-title').textContent = item ? titleOf(item) : 'Now playing';
  $('song-artist').textContent = '';
  $('song-line').textContent = '';
  $('song-next').textContent = '';
  $('song').hidden = false;
  try {
    const tags = await readSong(video.src, song.abort.signal);
    if (song?.id !== id) return;
    facts.song = { id, name: item?.name ?? null, tags: tags ? 'read' : 'none', title: tags?.title ?? null, artist: tags?.artist ?? null,
      cover: tags?.cover ? { type: tags.cover.type, bytes: tags.cover.size } : null,
      lyrics: tags?.lyrics ? { lines: tags.lyrics.cues.length, language: tags.lyrics.language } : null };
    if (!tags) return;
    if (!programme.screening?.titles?.[item?.name] && tags.title) $('song-title').textContent = tags.title;
    $('song-artist').textContent = tags.artist ?? '';
    if (tags.cover) {
      song.art = URL.createObjectURL(tags.cover);
      $('song-art').src = song.art;
      $('song-art').alt = `Cover art for ${$('song-title').textContent}`;
    }
    song.cues = tags.lyrics?.cues ?? null;
    songTick();
  } catch (e) {
    if (e.name !== 'AbortError') { note('song tags unread', { why: String(e) }); if (facts.song) facts.song.tags = 'failed'; }
  }
}

function songTick() {
  if (!song) return;
  if (video.paused) delete $('song').dataset.playing; else $('song').dataset.playing = '';
  if (!song.cues) return;
  const { now, next } = cueAt(song.cues, positionNow());
  if (song.shown === now && song.next === next) return;
  song.shown = now;
  song.next = next;
  $('song-line').textContent = now?.text ?? '';
  $('song-next').textContent = next?.text ?? '';
  facts.song.line = now?.text ?? null;
}

// ---------- Next showing ----------
//
// A screening that loops (one film, or a list) holds a late joiner's seat:
// instead of the middle of something, a countdown to the start of the next
// item, with that item downloading and the Station locked to the room's clock.
// When the room starts it, the picture starts here in step. Every time comes
// from the room's own figures (its position, and the start it agrees ahead),
// so this browser's clock does not matter.

// Joined this close to the start: just watch.
const SEAT_AFTER_S = 8;
// The picture starts this much before the agreed instant: play() takes a moment.
const PLAY_EARLY_MS = 30;
// In a list, the room starts the next item a short lead after the last one ends
// (0.8 s, and twice the slowest round trip it counts, at most 0.25 s for observers).
const QUEUE_LEAD_MS = 1300;
let premiere = null;
let soundWanted = false;
let lastLoop = null;
facts.restarts = [];
facts.premiere = null;
const holding = () => premiere?.phase === 'wait' || premiere?.phase === 'arming';

/** Only a looping screening with observers. Says what plays now and what comes next. */
function loopOf(view, item) {
  const st = view.state;
  const tl = st.timeline;
  if (!view.observer || !st.repeat || !st.items?.length || !item?.duration_ms || !tl?.playing) return null;
  const at = st.items.findIndex((i) => i.id === tl.item);
  const next = st.items[(at + 1) % st.items.length];
  return { durS: item.duration_ms / 1000, posS: view.position_us / 1e6, rate: tl.rate || 1, tl, next, single: st.items.length === 1 };
}

/** A plain title for an item: config.json's, or its file name tidied. */
function titleOf(item) {
  const given = programme.screening?.titles?.[item.name];
  if (given) return given;
  const base = item.name.replace(/\.[^.]+$/, '').replace(/^song-\d+-/, '').replace(/[-_]+/g, ' ').trim();
  return base.replace(/\b\w/g, (c) => c.toUpperCase()) || 'the next film';
}

/**
 * When the seat's item starts, on this page's clock. Exact once the room has
 * agreed the start (it does so a moment ahead); until then, the end of what
 * plays now, which is an estimate.
 */
function nextStart(view, loop) {
  const now = performance.now();
  const tl = loop.tl;
  if (tl.item === premiere.target && tl.anchor_pos_us === 0 && tl.generation !== premiere.gen0) {
    premiere.agreed = true;
    return now + (tl.anchor_room_us - view.room_us) / 1000;
  }
  premiere.agreed = false;
  return now + ((loop.durS - loop.posS) / loop.rate) * 1000 + (loop.single ? 0 : QUEUE_LEAD_MS);
}

function holdSeat(loop) {
  premiere.target = loop.next.id;
  premiere.from = loop.tl.item;
  premiere.rewound = false;
  premiere.gen0 = loop.tl.generation;
  premiere.title = loop.single ? null : titleOf(loop.next);
  facts.premiere.target = loop.next.name;
  // The Station downloads the item the seat waits for, not the one playing now.
  worker.postMessage({ t: 'want-item', id: premiere.target });
  $('pr-label').textContent = loop.single ? '// Next showing' : '// Up next';
  $('pr-lead').textContent = loop.single ? 'Next showing in' : `Next: ${premiere.title} in`;
  $('pr-sub').textContent = loop.single
    ? 'The film runs on a loop, and it is partway through. Your seat is held: the picture starts here from the top, in step with everyone.'
    : 'The room plays a list on a loop. Your seat is held: the picture starts here when the next one begins, in step with everyone.';
}

function premiereView(view, item) {
  const loop = view.joined && item ? loopOf(view, item) : null;
  // A start, seen from the room, for the facts and the tests: a new item, or
  // the same one from the top. Its instant is the agreed anchor.
  if (loop && lastLoop && (loop.tl.item !== lastLoop.item || loop.posS < lastLoop.posS - 10) && loop.tl.anchor_pos_us === 0) {
    facts.restarts.push({ at: Math.round(Date.now() + (loop.tl.anchor_room_us - view.room_us) / 1000), item: loop.tl.item });
  }
  if (loop) lastLoop = { item: loop.tl.item, posS: loop.posS };
  if (!premiere) {
    if (!view.joined || !item) return;
    const seat = loop && !live && !facts.liveFilm && !params.has('nowait') && loop.posS > SEAT_AFTER_S;
    if (!seat) { premiere = { phase: 'off' }; return; }
    premiere = { phase: 'wait', said: null };
    facts.premiere = { phase: 'wait', joinedAtPos: +loop.posS.toFixed(2), joinedDuring: item.name, predictions: [] };
    holdSeat(loop);
    premiere.startAt = nextStart(view, loop);
    boot(false);
    $('premiere').hidden = false;
    $('pr-sound').focus({ preventScroll: true });
    note('seat held for the next item', { inS: (premiere.startAt - performance.now()) / 1000, next: loop.next.name });
  }
  if (!holding() || !loop) return;
  // The room moved to something else than the seat's item (the list changed,
  // or skipped ahead): wait for whatever comes next now.
  if (loop.tl.item !== premiere.target && (loop.tl.item !== premiere.from || !view.state.items.some((i) => i.id === premiere.target))) {
    holdSeat(loop);
    note('seat moved to the next item', { next: loop.next.name });
  }
  premiere.startAt = nextStart(view, loop);
  const left = premiere.startAt - performance.now();
  facts.premiere.startsAtEpoch = Math.round(Date.now() + left);
  facts.premiere.agreed = premiere.agreed;
  if (facts.premiere.predictions.length < 600) facts.premiere.predictions.push([Date.now(), Math.round(Date.now() + left), premiere.agreed]);
  if (left < 2500) {
    // Back to the very first frame now, so the start needs no seek of its own.
    if (video.src && mediaId === premiere.target && video.paused && video.currentTime !== 0 && !premiere.rewound) { premiere.rewound = true; video.currentTime = 0; }
  }
  // Start only on the room's agreed instant, never on an estimate: before it,
  // the room still plays the last item.
  if (premiere.agreed) {
    clearTimeout(premiere.timer);
    premiere.timer = setTimeout(premiereGo, Math.max(0, left - PLAY_EARLY_MS));
  }
}

const countText = (s) => {
  const t = Math.max(0, Math.ceil(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const spoken = (s) => {
  const t = Math.max(0, Math.round(s));
  if (t >= 60) { const m = Math.round(t / 60); return `${m} minute${m === 1 ? '' : 's'}`; }
  return `${t} second${t === 1 ? '' : 's'}`;
};

/** On the Worker's beat: the countdown, the copy, and what a screen reader hears. */
function premiereTick() {
  if (premiere.phase === 'late') return premiereLate();
  if (!holding()) return;
  const left = (premiere.startAt - performance.now()) / 1000;
  $('pr-time').textContent = countText(left);
  const f = facts.swarm;
  const pct = f?.total ? Math.floor((f.have / f.total) * 100) : 0;
  $('pr-ready').textContent = f?.total ? `Your copy: ${pct}% ready` : 'Your copy: starting the download';
  $('pr-ready-row').style.setProperty('--p', f?.total ? f.have / f.total : 0);
  // Said politely, and only now and then: on arrival, each minute, then 30 and 10 seconds.
  const marks = [10, 30, ...Array.from({ length: 180 }, (_, i) => (i + 1) * 60)];
  const due = premiere.said === null ? Math.ceil(left) : marks.find((m) => left <= m && premiere.said > m);
  if (due !== undefined) {
    premiere.said = Math.ceil(left);
    $('pr-say').textContent = `${premiere.title ? `Next: ${premiere.title}, in` : 'Next showing in'} ${spoken(left)}. Your copy is ${pct}% ready.`;
  }
  // A hidden tab may miss the page timer: the Worker's beat starts it too.
  if (premiere.agreed && left * 1000 <= PLAY_EARLY_MS) premiereGo();
}

/** The top of the film: start the picture in step, or as soon as the copy can. */
async function premiereGo() {
  if (!holding() || premiere.phase === 'arming') return;
  premiere.phase = 'arming';
  clearTimeout(premiere.timer);
  const ready = video.src && mediaId === premiere.target && video.readyState >= 3;
  facts.premiere.wentAt = Date.now();
  facts.premiere.readyAtStart = ready;
  // Late to the start (a hidden tab, or a start agreed only at the last moment):
  // begin where the room is, while the picture is still covered.
  const late = (performance.now() - premiere.startAt) / 1000;
  if (ready) {
    if (late > 0.1) video.currentTime = late;
    else if (video.currentTime > 0.05) video.currentTime = 0;
    video.playbackRate = 1;
    video.addEventListener('playing', () => { facts.premiere.playLagMs = Math.round(performance.now() - premiere.startAt); }, { once: true });
    video.muted = !soundWanted;
    try {
      await video.play();
    } catch (e) {
      // Autoplay rules: start without sound; the sound button stays on the picture.
      video.muted = true;
      facts.autoMuted = true;
      await video.play().catch(() => {});
    }
  } else {
    video.muted = !soundWanted;
  }
  // Steering resumes once the room is past the top, so a sample sent a few
  // milliseconds early cannot pull the picture back to the end.
  const wait = Math.max(0, premiere.startAt - performance.now()) + 150;
  setTimeout(() => {
    premiere.phase = ready ? 'started' : 'late';
    facts.premiere.phase = premiere.phase;
    worker.postMessage({ t: 'want-item', id: null });
    if (ready) {
      $('premiere').hidden = true;
      $('pr-say').textContent = '';
      soundUi();
      note('next showing started in step');
    } else {
      note('next showing started before the copy was ready');
      premiereLate();
    }
  }, wait);
}

/** Started without enough of the copy: say so, and show the picture once it plays. */
function premiereLate() {
  if (!video.paused && video.readyState >= 3) {
    premiere.phase = 'started';
    facts.premiere.phase = 'started';
    facts.premiere.lateStartAt = Date.now();
    $('premiere').hidden = true;
    soundUi();
    return;
  }
  const box = $('premiere');
  if (box.dataset.state !== 'late') {
    box.dataset.state = 'late';
    $('pr-label').textContent = '// Starting';
    $('pr-lead').textContent = 'Starting as soon as your copy is ready';
    $('pr-time').textContent = '';
    $('pr-sub').textContent = 'The showing has begun. Your copy needs a little more, then the picture joins in step.';
    $('pr-say').textContent = 'The showing has begun. The picture joins as soon as your copy is ready.';
    $('pr-now').hidden = true;
  }
  const f = facts.swarm;
  if (f?.total) $('pr-ready').textContent = `Your copy: ${Math.floor((f.have / f.total) * 100)}% ready`;
}

$('pr-sound').onclick = () => {
  soundWanted = !soundWanted;
  $('pr-sound').setAttribute('aria-pressed', String(soundWanted));
  $('pr-sound').textContent = soundWanted ? 'Sound on at the start' : 'Turn sound on';
  // A tap now lets the browser start the film with sound later.
  if (soundWanted && video.src && video.paused && holding()) {
    // Silent: the tap itself is what lets sound start later.
    video.muted = true;
    video.play().then(() => { if (holding()) { video.pause(); video.currentTime = 0; } }).catch(() => {});
  }
  if (premiere?.phase === 'late') video.muted = !soundWanted;
};
$('pr-now').onclick = () => {
  if (!holding()) return;
  clearTimeout(premiere.timer);
  premiere.phase = 'skipped';
  facts.premiere.phase = 'skipped';
  worker.postMessage({ t: 'want-item', id: null });
  facts.premiere.skippedAt = Date.now();
  video.muted = !soundWanted && video.muted;
  $('premiere').hidden = true;
  boot(true, { label: '// Joining the showing', title: 'Starting from the middle', sub: 'Locking to the room. The picture appears in a moment.' });
  $('stage').focus({ preventScroll: true });
  note('watching from the middle');
};

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
  $('unmute').hidden = !(off && !video.paused && $('boot').hidden && $('premiere').hidden);
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
  $('f-ahead').textContent = ahead >= 0.1 ? `${ahead.toFixed(ahead < 10 ? 1 : 0)} s ready` : 'Nothing yet';
  // Pace: the speed trim that keeps this Station on the room's moment.
  const trim = (video.playbackRate - 1) * 100;
  $('f-pace').textContent = video.paused || Math.abs(trim) < 0.5 ? 'Normal'
    : trim > 0 ? `+${trim.toFixed(1)}%, catching up` : `${trim.toFixed(1)}%, easing back`;
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
  roster(view);
  queue(view);
}

const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav)$/i;
let queueKey = '';

/** What the room will play, in order. Read only: the host sets it from the app. */
function queue(view) {
  const st = view.state;
  const items = st.items ?? [];
  $('queue-panel').hidden = !items.length;
  const now = st.timeline?.item;
  const at = items.findIndex((i) => i.id === now);
  const next = at < 0 ? -1 : at + 1 < items.length ? at + 1 : st.repeat && items.length > 1 ? 0 : -1;
  const key = JSON.stringify([items.map((i) => [i.id, i.name, i.duration_ms]), at, next, st.repeat, !!programme.screening?.titles]);
  if (key === queueKey) return;
  queueKey = key;
  const rows = items.map((item, i) => {
    const li = Object.assign(document.createElement('li'), { className: 'q-item' });
    if (i === at) { li.dataset.now = ''; li.setAttribute('aria-current', 'true'); }
    const title = titleOf(item);
    li.append(
      Object.assign(document.createElement('span'), { className: 'q-n', textContent: String(i + 1).padStart(2, '0') }),
      Object.assign(document.createElement('span'), { className: 'q-title', textContent: title, title: item.name, dir: 'auto' }),
      Object.assign(document.createElement('span'), { className: 'q-kind', textContent: AUDIO.test(item.name) ? 'Song' : 'Film' }),
      Object.assign(document.createElement('span'), { className: 'q-dur', textContent: item.duration_ms ? clock(item.duration_ms / 1000) : '' }),
    );
    const chip = (text, tone, solid) => {
      const c = Object.assign(document.createElement('span'), { className: `chip${solid ? ' solid' : ''}`, textContent: text });
      c.dataset.tone = tone;
      li.append(c);
    };
    if (i === at) chip(st.timeline.playing ? 'Now' : 'Paused', 'green', true);
    else if (i === next) chip('Next', 'violet');
    return li;
  });
  $('queue').replaceChildren(...rows);
  const total = items.reduce((t, i) => t + (i.duration_ms ?? 0), 0);
  const parts = [`${items.length} ${items.length === 1 ? 'item' : 'items'}${total ? `, ${clock(total / 1000)}` : ''}.`];
  if (st.repeat) parts.push('On a loop: after the last, it starts again from the top.');
  parts.push(view.observer ? 'The host chooses what plays.' : 'To change the queue, open this room in the Tandem app.');
  $('queue-note').textContent = parts.join(' ');
}

/** Who else watches along, by name: at most 20 from the room's master, then a count. */
function roster(view) {
  const r = view.roster;
  $('roster').hidden = !r;
  if (!r) return;
  const li = (cls, text, title) => Object.assign(document.createElement('li'), { className: cls, textContent: text, title: title ?? text });
  const rows = [];
  if (!r.off) {
    if (view.observer) {
      const me = view.stations.find((s) => s.is_you)?.name || 'You';
      const row = document.createElement('li');
      row.dataset.you = '';
      row.append(Object.assign(document.createElement('span'), { className: 'name', textContent: me, title: me }),
        Object.assign(document.createElement('span'), { className: 'you', textContent: r.listed ? '(you)' : '(you, not shown to others)' }));
      rows.push(row);
    }
    for (const name of r.names) {
      const row = li('', '');
      row.append(Object.assign(document.createElement('span'), { className: 'name', textContent: name, title: name, dir: 'auto' }));
      rows.push(row);
    }
    if (r.more) rows.push(li('more', `+ ${r.more} more`, 'Past the first 20, or chose not to be named'));
  }
  $('roster-names').replaceChildren(...rows);
  const note = r.off ? 'The host shows only how many are watching.' : !r.names.length && !r.more ? 'Nobody else is watching along yet.' : '';
  $('roster-note').textContent = note;
  $('roster-note').hidden = !note;
}

/** Whether this browser lets itself be named in other viewers' lists. On unless turned off here. */
function showName() {
  try { return localStorage.getItem('tandem-show-name') !== 'off'; } catch { return true; }
}
$('show-name').checked = showName();
$('show-name').addEventListener('change', (e) => {
  const on = e.currentTarget.checked;
  try { localStorage.setItem('tandem-show-name', on ? 'on' : 'off'); } catch { /* this visit only */ }
  worker.postMessage({ t: 'listed', on });
});

/** Renames this Station in the room, and remembers the name on this device. */
const renameDirty = () => {
  const v = $('my-name').value.trim();
  $('rename-save').disabled = !v || v === savedName();
};
$('my-name').addEventListener('input', renameDirty);
$('my-name').addEventListener('blur', () => { if (!$('rename-save').disabled) $('rename').requestSubmit(); });
$('my-name').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('my-name').value = savedName(); renameDirty(); }
});
$('rename').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('my-name').value.trim();
  if (!name) { $('my-name').value = savedName(); renameDirty(); return; }
  try { localStorage.setItem('tandem-name', name); } catch { /* this visit only */ }
  worker.postMessage({ t: 'name', name });
  $('my-name').value = name;
  renameDirty();
  $('rename-note').textContent = `Saved. Others see you as ${name}.`;
});

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
  if (holding()) { chip('Seat held', 'violet'); return; }
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
  facts.mirrorHosts = data.hosts;
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
  if (f?.total) {
    const m = f.mirror;
    $('f-source').textContent = !m ? 'The room' : m.up ? `Mirror, ${mb(m.bytes)}${f.pulled_bytes > m.bytes ? `, room ${mb(f.pulled_bytes - m.bytes)}` : ''}` : 'The room (mirror not answering)';
  }
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
  premiereView(view, item);
  const now = performance.now();
  if (now - lastView > 1000) {
    lastView = now;
    $('facts').textContent = JSON.stringify({ stages: facts.stages, film: facts.film && { kind: facts.film.kind, size: facts.film.size, kept: facts.film.kept }, swarm: f, clock: view.clock, links: data.links }, null, 1);
  }
}

/** The boot steps after joining, and the bar, on the Worker's beat. */
function progress() {
  const ahead = bar();
  if (premiere) premiereTick();
  if (!room?.joined || holding()) return;
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
      $('f-store').textContent = storeLabel(data);
      if (data.how === 'own-copy') note('own copy', { slot: data.slot });
      show(data.id, data.sid);
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
    case 'storage-wait': note('waiting for the last Station to let go of the film', { slot: data.slot }); break;
    case 'closed': facts.closed = true; break;
    case 'tick': sample(); progress(); songTick(); if (room) syncUi(room); break;
    case 'lag': facts.workerLag = data.ms; break;
    case 'directive': apply(data.d); break;
    case 'miss': note('read waits for a chunk', { index: data.index }); break;
    case 'mirror-off': facts.mirrorOff = data.why; note('no mirror', { why: data.why }); break;
    case 'error': {
      facts.error = data.text;
      const t = String(data.text);
      if (/relay/i.test(t)) fail('No relay answered', 'This browser could not reach any Tandem relay. Check the connection, then try again.', 'relay');
      else if (/ticket/i.test(t)) fail('This invite does not work', 'It could not be read. Ask the host for a fresh invite.', 'room');
      else if (data.kind === 'storage' || /storage|quota/i.test(t)) storageFailed(data.name, t);
      else if (/wasm|WebAssembly|compile/i.test(t)) fail('The Station did not load', 'The download may have been cut off. Try again.', 'station');
      else fail('Something stopped the Station', `The browser said: ${t}`, stepNow);
      break;
    }
    default: break;
  }
};

/** Where the film is kept, and with whom. */
function storeLabel(f) {
  const where = f.kind === 'bucket' ? 'Storage bucket' : f.kind === 'opfs' ? 'Private files' : f.kind;
  if (f.how === 'shared') return `${where}, shared with another tab`;
  if (f.how === 'own-copy') return `${where}, this tab's own copy (Tandem is open in another tab)`;
  return where;
}

/** A storage error in plain words: what it means, not every reason it might. */
function storageFailed(name, said) {
  if (name === 'QuotaExceededError') {
    fail('There is no room for the film', 'The disk, or the space this browser gives a site, is full. Free some space, then try again.', 'picture');
  } else if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError') {
    fail('The film is in use in other tabs', 'Tandem is open in several other tabs or windows, and this browser lets only one use a film\'s files at a time. Close one of them, then try again.', 'picture');
  } else if (name === 'SecurityError' || name === 'NotAllowedError') {
    fail('This browser would not store the film', 'Private windows often keep sites from storing files. Open this page in a normal window.', 'picture');
  } else {
    fail('This browser would not store the film', `The browser said: ${said}`, 'picture');
  }
}

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
video.addEventListener('loadedmetadata', () => { seeking = false; note('metadata', { duration: video.duration }); if (!video.videoWidth) songOn(); else songOff(); });
video.addEventListener('timeupdate', songTick);
video.addEventListener('volumechange', soundUi);
video.addEventListener('error', () => {
  facts.videoError = video.error?.message ?? String(video.error?.code);
  note('video error', { message: facts.videoError });
  if (video.error?.code === 4) fail('This browser cannot play this film', 'Its format is not one browsers play. Open the room in the Tandem app, or ask the host for an MP4.', 'picture');
});
// Leaving, reloading or closing: the Station lets go of the film's files and
// says goodbye first, so the next Station (here or in another tab) has them.
let gone = false;
const goodbye = () => { if (!gone) { gone = true; worker.postMessage({ t: 'bye' }); } };
window.addEventListener('pagehide', goodbye);
window.addEventListener('beforeunload', goodbye);
// Back from the back-forward cache, the Station has already said goodbye: start again.
window.addEventListener('pageshow', (e) => { if (e.persisted && gone) location.reload(); });

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
function join(invite, name, unnamed = false) {
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
  $('my-name').value = unnamed ? '' : name;
  if (facts.wasm) setStep('relay', 'Finding the nearest relay');
  worker.postMessage({
    t: 'join', invite, name, key: stationKey(), listed: showName() && !unnamed,
    window: Number(params.get('window') ?? 0), noBuckets: params.has('nobuckets'), small: params.has('small'),
    // For tests: one tab per copy of the film, as in a browser that cannot share files.
    noShare: params.has('noshare'),
    // For tests only: the receive window in KiB, where 0 means QUIC's defaults.
    windowKb: params.has('windowkb') ? Number(params.get('windowkb')) : undefined,
    forget: (params.get('forget') ?? '').split(',').filter(Boolean).map(Number),
    // For tests: a mirror's base URL instead of config.json's, or no mirror at all.
    mirror: params.get('mirror') ?? undefined, noMirror: params.has('nomirror'),
  });
}

function savedName() {
  try { return localStorage.getItem('tandem-name') || 'Guest'; } catch { return 'Guest'; }
}

/** Whether this browser has been given a name; "Guest" was only ever a stand-in. */
function hasName() {
  try { const n = localStorage.getItem('tandem-name')?.trim(); return !!n && n !== 'Guest'; } catch { return false; }
}

/**
 * No name yet: ask in a modal while the Station joins and fetches behind it.
 * Until then it is in the room unnamed and left out of who is watching along.
 */
function askName() {
  const dlg = $('ask-name');
  $('ask-name-input').value = '';
  // A name is needed: Escape does not close it.
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  $('ask-name-form').addEventListener('submit', (e) => {
    const name = $('ask-name-input').value.trim();
    if (!name) {
      e.preventDefault();
      $('ask-name-warn').textContent = 'Type a name, so the others know who joined.';
      $('ask-name-input').focus();
      return;
    }
    try { localStorage.setItem('tandem-name', name); } catch { /* this visit only */ }
    worker.postMessage({ t: 'name', name });
    worker.postMessage({ t: 'listed', on: showName() });
    $('my-name').value = name;
    renameDirty();
  });
  dlg.showModal();
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
  $('name').value = hasName() ? savedName() : '';
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
  // No name typed: the room page asks for one.
  try { if ($('name').value.trim()) localStorage.setItem('tandem-name', $('name').value.trim()); } catch { /* fine */ }
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
  if (hasName()) join(appLink(ticket), savedName());
  else { join(appLink(ticket), '', true); askName(); }
}

if (!('Worker' in window) || !navigator.serviceWorker || !window.WebAssembly) {
  fail('This browser cannot run Tandem', 'It needs WebAssembly, Workers and a Service Worker. A current Chrome, Edge, Firefox or Safari has them. Private windows in some browsers turn them off.');
} else {
  start();
}
soundUi();
fullUi();
