// The show: doors open, the count-in, the lights, the pass, and the anthem.
// app.js fills the page from config.json; this runs the stagecraft on top. Every
// part fails quietly: without it the page is still complete and usable.
window.showRunning = true;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const html = document.documentElement;
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hero = $('#doors');
const FPS = 24;

let arena = null;
let heroVisible = true;
let lightsTarget = 0.12, lights = calm ? 1 : 0.04;

/* ---------- Every screen shows the same count. ---------- */
function sync(value, status, side = value) {
  for (const el of $$('[data-sync]')) {
    const v = String(el.closest('.side-screen') ? side : value);
    if (el.textContent === v) continue;
    el.textContent = v;
    if (el.classList.contains('count-n')) { el.classList.remove('flip'); void el.offsetWidth; el.classList.add('flip'); }
  }
  if (status) $('#side-status').textContent = status;
}

function hit() {
  if (calm) return;
  document.body.classList.remove('hit');
  void document.body.offsetWidth;
  document.body.classList.add('hit');
}

/* ---------- Doors open, then the count-in, then the headliner. ---------- */
function intro() {
  if (calm || html.dataset.phase === 'live') { goLive(false); return; }
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  html.dataset.phase = 'doors';
  sync(3, 'Doors open');
  at(750, () => { html.dataset.phase = 'count'; sync(3, 'Show starts in'); lightsTarget = 0.18; });
  at(1400, () => { sync(2); lightsTarget = 0.26; });
  at(2050, () => { sync(1); lightsTarget = 0.34; });
  at(2700, () => goLive(true));
  // Any key, click or scroll skips straight to the show.
  const skip = () => { timers.forEach(clearTimeout); goLive(true); };
  for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) addEventListener(type, skip, { once: true, passive: true });
  function goLiveCleanup() { for (const type of ['keydown', 'pointerdown', 'wheel', 'touchstart']) removeEventListener(type, skip); }
  intro.cleanup = goLiveCleanup;
}

function goLive(withHit) {
  intro.cleanup?.();
  html.dataset.phase = 'live';
  sync('0', 'On air', 'LIVE');
  lightsTarget = 1;
  if (withHit) hit();
}

/* ---------- The arena: loaded after first paint, only where WebGL works. ---------- */
async function startLights() {
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl')) return;
  try {
    const { startArena } = await import('./arena.js');
    arena = startArena($('#arena'), { still: calm });
  } catch { arena = null; }
  if (!arena) return;
  document.body.classList.add('gl');
  arena.set({ intro: lights });
  wake();
}

function wake() {
  const on = heroVisible && !document.hidden && !stageBusy();
  arena?.play(on);
  if ((on || playing) && !loopId) loopId = requestAnimationFrame(loop);
}

const stageBusy = () => { const v = $('#trailer'); return v && !v.paused && !v.ended; };

/* ---------- The pass: tilt, foil and its code. ---------- */
function pass() {
  const ticket = $('#ticket');
  const wrap = $('.pass-wrap');
  if (!ticket || calm) return;
  let frame = 0, goal = null;
  const apply = () => {
    frame = 0;
    if (!goal) return;
    ticket.style.setProperty('--rx', `${(-goal.y * 12).toFixed(2)}deg`);
    ticket.style.setProperty('--ry', `${(goal.x * 16).toFixed(2)}deg`);
    ticket.style.setProperty('--mx', (0.5 + goal.x * 0.9).toFixed(3));
    ticket.style.setProperty('--my', (0.5 + goal.y * 0.9).toFixed(3));
  };
  const aim = (x, y) => { goal = { x: Math.max(-0.5, Math.min(0.5, x)), y: Math.max(-0.5, Math.min(0.5, y)) }; if (!frame) frame = requestAnimationFrame(apply); };
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const r = ticket.getBoundingClientRect();
    aim((e.clientX - r.left) / r.width - 0.5, (e.clientY - r.top) / r.height - 0.5);
  });
  wrap.addEventListener('pointerleave', () => aim(0, 0));
  // On a phone, the pass follows the tilt where the browser allows it without asking.
  addEventListener('deviceorientation', (e) => {
    if (e.gamma == null || !heroVisible) return;
    aim(e.gamma / 60, (e.beta - 45) / 70);
  }, { passive: true });
}

/** The pass's code: the pass link without any invite, so a photo of it never opens a room. */
async function passCode(ticket) {
  const box = $('#qr');
  if (!box) return;
  const params = new URLSearchParams();
  for (const key of ['show', 'date', 'time', 'seat']) if (ticket[key]) params.set(key, ticket[key]);
  const link = `${location.origin}${location.pathname}#${params}`;
  try {
    const { default: qrcode } = await import('./vendor/qrcode-generator-2.0.4/qrcode.mjs');
    const qr = qrcode(0, 'L');
    qr.addData(link, 'Byte');
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    box.innerHTML = `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="#07040f" d="${d}"/></svg>`;
    box.title = 'This pass, without any room invite';
  } catch { /* the stripes stay */ }
}

/* ---------- Things light up as they come into view. ---------- */
// Chants roll only while on screen; everything else stays lit once lit.
const seen = 'IntersectionObserver' in window && !calm ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.target.classList.contains('chant')) e.target.classList.toggle('lit', e.isIntersecting);
    else if (e.isIntersecting) { e.target.classList.add('lit'); seen.unobserve(e.target); }
  }
}, { threshold: 0.2 }) : null;

/** Watches everything marked data-lit. Runs again once app.js has built the setlist and chants. */
function lightUp() {
  for (const el of $$('[data-lit]:not([data-watched])')) {
    el.dataset.watched = '';
    if (seen) seen.observe(el); else el.classList.add('lit');
  }
}

/* ---------- The anthem. Never automatic: only a press starts it. ---------- */
const audio = $('#anthem');
let audioCtx = null, analyser = null, bins = null, song = null, playing = false;
let level = { bass: 0, kick: 0, drop: 0, high: 0, black: 0 }, bassAvg = 0.3, lastKick = 0, lastT = 0, lineIndex = -1, songPhase = '';

function soundButtons(on) {
  for (const b of $$('[data-sound]')) {
    const label = $('.sound-label', b);
    const header = b.classList.contains('sound');
    label.textContent = on ? (header ? 'Sound off' : 'Stop the anthem') : (header ? 'Sound on' : 'Play the anthem');
    b.toggleAttribute('data-on', on);
  }
  document.body.classList.toggle('playing', on);
}

async function lyrics(url) {
  if (song || !url) return;
  try { song = await (await fetch(url)).json(); } catch { song = null; }
}

function startSound() {
  const anthem = window.tandem?.anthem;
  if (!anthem) return;
  if (!audio.src) {
    const pick = anthem.sources.find((s) => audio.canPlayType(s.type)) ?? anthem.sources.at(-1);
    audio.src = pick.src;
  }
  lyrics(anthem.lyrics);
  if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;
      audioCtx.createMediaElementSource(audio).connect(analyser);
      analyser.connect(audioCtx.destination);
      bins = new Uint8Array(analyser.frequencyBinCount);
    } catch { analyser = null; }
  }
  audioCtx?.resume();
  if (audio.ended) audio.currentTime = 0;
  const trailer = $('#trailer');
  if (trailer && !trailer.paused) trailer.pause();
  audio.play().catch(() => { soundButtons(false); });
  if ('mediaSession' in navigator && window.MediaMetadata) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: anthem.title, artist: 'Tandem', album: anthem.subtitle, artwork: [{ src: anthem.art, sizes: '480x480', type: 'image/webp' }] });
  }
}

function stopSound() { audio.pause(); }

function onSoundState() {
  playing = !audio.paused && !audio.ended;
  soundButtons(playing);
  if (playing) { wake(); return; }
  // Back to the house lights.
  level = { bass: 0, kick: 0, drop: 0, high: 0, black: 0 };
  arena?.set({ ...level, music: false });
  glow(0);
  for (const bar of $$('.eq i')) bar.style.transform = '';
  lineIndex = -1;
  lanes.forEach((lane, n) => { lane.i = -1; laneSay(lane, document.querySelectorAll('.k-now')[n], null); });
  laneSay({ words: [] }, document.querySelector('.k-prev'), null);
  if (songPhase) { songPhase = ''; goLive(false); }
}

function wireSound() {
  for (const b of $$('[data-sound]')) b.addEventListener('click', () => (playing ? stopSound() : startSound()));
  for (const type of ['play', 'playing', 'pause', 'ended']) audio.addEventListener(type, onSoundState);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && playing) stopSound(); });
}

/** One audio frame: levels from the analyser, the beat grid from the song's tempo. */
function listen(dt) {
  const t = audio.currentTime;
  if (analyser) {
    analyser.getByteFrequencyData(bins);
    const avg = (a, b) => { let s = 0; for (let i = a; i < b; i++) s += bins[i]; return s / (b - a) / 255; };
    const bass = avg(1, 5), mid = avg(8, 40), high = avg(60, 200);
    bassAvg += (bass - bassAvg) * 0.05;
    const now = performance.now();
    if (bass > bassAvg * 1.12 && bass > 0.42 && now - lastKick > 240) { level.kick = 1; lastKick = now; }
    level.bass = bass; level.high = high;
    const bars = $$('.eq i');
    [bass, mid, high, (bass + high) / 2].forEach((v, i) => { if (bars[i]) bars[i].style.transform = `scaleY(${(Math.round((0.2 + v * 0.95) * 20) / 20).toFixed(2)})`; });
  }
  level.kick *= Math.exp(-dt * 7);
  // The big hits from the song's cue sheet lift the whole room once.
  if (song) {
    for (const [ht, strength] of song.hits) if (strength >= 3 && lastT < ht && t >= ht) { level.drop = 1; hit(); }
    const stop = t >= 127.93 && t < 130.54;
    level.black += ((stop ? 1 : 0) - level.black) * Math.min(1, dt * 6);
  }
  level.drop *= Math.exp(-dt * 2.2);
  const beat = song ? 60 / song.bpm : 0.32609;
  const bar = Math.max(0, (t - (song?.firstBeat ?? 0.102)) / (beat * 4));
  arena?.set({ ...level, bar, music: true });
  glow(Math.max(level.kick, level.drop));
  if (song) { karaoke(t); countIn(t); }
  lastT = t;
}

/** The beat on the page: opacity only, rounded so most frames change nothing. */
let lastGlow = -1;
function glow(v) {
  const q = calm ? 0 : Math.round(v * 20) / 20;
  if (q === lastGlow) return;
  lastGlow = q;
  const wall = $('.wall-glow');
  if (wall) wall.style.opacity = q;
  for (const p of $$('.lit .pillar')) p.style.opacity = (0.6 + q * 0.4).toFixed(2);
}

// Lines may overlap when the two singers sing different words at once; each shown
// line gets a lane of its own and fills on its own word times.
const lanes = [{ i: -1, words: [] }, { i: -1, words: [] }];

function laneSay(lane, el, line) {
  el.replaceChildren();
  lane.words = [];
  if (!line) return;
  const who = line[5] ?? '';  // f her, m him, b both: one letter for the line, or one per word
  line[2].split(/\s+/).filter(Boolean).forEach((word, n) => {
    if (n) el.append(' ');
    const w = document.createElement('span');
    w.className = 'k-w';
    const v = who.length > 1 ? who[n] : who;
    if (v) w.classList.add(v);
    w.textContent = word;
    el.append(w);
    lane.words.push({ el: w, len: word.length, p: -1 });
  });
  el.classList.toggle('scream', line[3] === 'scream' || line[3] === 'gang');
}

function laneFill(lane, line, t) {
  const words = lane.words, times = line[4];
  let fillOf;
  if (times && times.length === words.length) {
    const k = times.findLastIndex((w) => w <= t);
    const end = times[k + 1] ?? line[1];
    const part = k < 0 ? 0 : Math.min(1, (t - times[k]) / Math.max(0.05, end - times[k]));
    fillOf = (n) => (n < k ? 1 : n === k ? part : 0);
  } else {
    // No word times: spread the line's time over its letters, word after word.
    const total = words.reduce((sum, w) => sum + w.len, 0) || 1;
    let left = Math.max(0, Math.min(1, (t - line[0]) / Math.max(0.1, line[1] - line[0]))) * total;
    const parts = words.map((w) => { const f = Math.max(0, Math.min(1, left / w.len)); left -= w.len; return f; });
    fillOf = (n) => parts[n];
  }
  words.forEach((w, n) => {
    const p = Math.round(fillOf(n) * 100);
    if (p === w.p) return;
    w.p = p;
    w.el.style.setProperty('--p', `${p}%`);
    w.el.classList.toggle('done', p >= 100);
  });
}

function karaoke(t) {
  const lines = song.lines;
  const last = lines.findLastIndex((l) => l[0] <= t);
  // Shown: the newest line (held 1.5 s after it ends), and an older one still being sung.
  const shown = [];
  for (let j = last; j >= 0 && j > last - 4; j--) {
    const l = lines[j];
    if (j === last ? t < l[1] + 1.5 : t < l[1] - 0.05 && l[1] > lines[last][0] + 0.1) shown.unshift(j);
  }
  const want = shown.slice(-2);
  const els = document.querySelectorAll('.k-now');
  // Keep a line in the lane it started in; put new lines in a free lane, the top one first.
  lanes.forEach((lane, n) => {
    if (lane.i >= 0 && !want.includes(lane.i)) { lane.i = -1; laneSay(lane, els[n], null); }
  });
  for (const j of want) {
    if (lanes.some((lane) => lane.i === j)) continue;
    const n = lanes[0].i < 0 ? 0 : 1;
    if (lanes[n].i >= 0) continue;
    lanes[n].i = j;
    laneSay(lanes[n], els[n], lines[j]);
  }
  if (last !== lineIndex) {
    lineIndex = last;
    // The line before, dimmed and already filled, unless it is still being sung in a lane.
    const prevEl = document.querySelector('.k-prev');
    const p = last - 1;
    if (prevEl) {
      const lane = { words: [] };
      laneSay(lane, prevEl, p >= 0 && !want.includes(p) && t < lines[p][1] + 12 ? lines[p] : null);
      lane.words.forEach((w) => { w.el.style.setProperty('--p', '100%'); });
    }
    document.querySelector('.karaoke').classList.toggle('voices', lines.some((l) => l[5]));
    document.querySelector('.k-next').textContent = lines[last + 1]?.[2] ?? '';
  }
  lanes.forEach((lane) => { if (lane.i >= 0) laneFill(lane, lines[lane.i], t); });
}

/** The song has its own count-in. Every screen counts with it. */
function countIn(t) {
  const c = song.countdown;
  let phase = '';
  if (t >= c.intro && t < c.three) phase = 'ready';
  else if (t >= c.three && t < c.two) phase = '3';
  else if (t >= c.two && t < c.one) phase = '2';
  else if (t >= c.one && t < c.go) phase = '1';
  if (phase === songPhase) return;
  songPhase = phase;
  if (!phase) { goLive(true); return; }
  html.dataset.phase = 'count';
  sync(phase === 'ready' ? '·' : phase, 'Show starts in');
}

/* ---------- One loop for the director: the lights' level, timecode, and the music. ---------- */
let loopId = 0, lastFrame = 0, lastCode = 0;
const t0 = performance.now();
const code = $('#timecode');

function timecode(seconds) {
  const f = Math.floor(seconds * FPS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(f / (FPS * 3600)))}:${pad(Math.floor(f / (FPS * 60)) % 60)}:${pad(Math.floor(f / FPS) % 60)}:${pad(f % FPS)}`;
}

function loop(now) {
  const active = (heroVisible && !document.hidden) || playing;
  if (!active) { loopId = 0; lastFrame = 0; return; }
  loopId = requestAnimationFrame(loop);
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.016;
  lastFrame = now;
  if (Math.abs(lights - lightsTarget) > 0.001) {
    lights += (lightsTarget - lights) * Math.min(1, dt * (lightsTarget > 0.9 ? 2.2 : 4));
    arena?.set({ intro: lights });
  }
  if (playing) listen(dt);
  // The timecode counts frames, redrawn at half rate to keep the page light.
  if (heroVisible && code && now - lastCode > 2000 / FPS) {
    lastCode = now;
    code.textContent = timecode(playing ? audio.currentTime : calm ? 0 : (now - t0) / 1000);
  }
}

/* ---------- Start. ---------- */
function begin() {
  intro();
  lightUp();
  pass();
  wireSound();
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; wake(); }, { threshold: 0.02 }).observe(hero);
  }
  document.addEventListener('visibilitychange', wake);
  const trailer = $('#trailer');
  for (const type of ['play', 'pause', 'ended']) trailer?.addEventListener(type, () => {
    if (type === 'play' && playing) stopSound();
    wake();
  });
  // The lights load once the page has painted and settled.
  const later = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 200));
  const go = () => later(startLights, { timeout: 1200 });
  if (document.readyState === 'complete') go(); else addEventListener('load', go, { once: true });
  loopId = requestAnimationFrame(loop);
}

function ready() {
  if (!window.tandem) return;
  lightUp();
  const later = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 300));
  later(() => passCode(window.tandem.ticket), { timeout: 2000 });
}

// A read-only handle for checking the show in a test browser.
window.tandemShow = { get arena() { return arena; }, get playing() { return playing; } };

begin();
if (window.tandem) ready(); else document.addEventListener('tandem:ready', ready, { once: true });
