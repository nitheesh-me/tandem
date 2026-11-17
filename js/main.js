// Tandem, as one moving picture in nine acts. Every screen in a room plays the same film. Here one screen
// sends an invite that hops screen to screen with no server in the middle; friends fly in from far away, each
// with their own local time and script; only one of them has the film, and it streams out from that screen
// until every screen fills; the screens play, each at its own moment, then fly into one wall and lock; the room
// waits for one friend who is buffering; the host leaves and the room plays on; and the wall becomes the mark.
// Scroll, drag, use the arrow keys or 1 to 9 to move along; press and hold to pull the room into sync. The
// pointer is a late station: the screens it passes slip out of time and pull back into phase behind it.
// Written for this site: WebGL2 and WebAudio with no libraries.
import { buildWall, tileCentre, HANDLES, STRIDE } from './wall.js';
import * as S from './shaders.js';
import { program, target, pair, fullscreen, perspective, lookAt, mul, project } from './gl.js';
import { Sound, loadScore, progress } from './audio.js';

const $ = (s) => document.querySelector(s);
const root = document.documentElement;
const Q = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || Q.has('still');
const canvas = $('#gl'), hud = $('#hud'), stage = $('#stage'), rail = $('#rail'), soundBtn = $('#sound'), finale = $('#final');
const ACTS = [['00', 'signal', 0], ['01', 'invite', 0.07], ['02', 'arrivals', 0.16], ['03', 'one has the film', 0.26], ['04', 'apart', 0.36],
  ['05', 'together', 0.47], ['06', 'waiting', 0.6], ['07', 'host leaves', 0.71], ['08', 'one frame', 0.84]];
const SCORE = /^(techno|cine)$/.test(Q.get('score') || '') ? Q.get('score') : 'techno';
// where each friend is, for the arrivals: a city, its name in its own script and the locale for its local time
const PLACES = [
  ['Berlin', 'Berlin', 'de-DE', 'Europe/Berlin'], ['Dubai', 'دبي', 'ar-AE-u-nu-arab', 'Asia/Dubai'], ['Tokyo', '東京', 'ja-JP', 'Asia/Tokyo'],
  ['São Paulo', 'São Paulo', 'pt-BR', 'America/Sao_Paulo'], ['Seoul', '서울', 'ko-KR', 'Asia/Seoul'], ['London', 'London', 'en-GB', 'Europe/London'],
  ['Reykjavík', 'Reykjavík', 'is-IS', 'Atlantic/Reykjavik'], ['Mumbai', 'मुंबई', 'hi-IN-u-nu-deva', 'Asia/Kolkata']];
const fmt = PLACES.map(([, , loc, tz]) => { try { return new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }); } catch { return null; } });
const SLOW = 6; // moonmilk.07 is the one who buffers

// ---------- The words layer works with or without the picture
const read = $('#read'), wordsBtn = $('#words'), closeBtn = $('#read-close');
closeBtn.tabIndex = -1;
function toggleWords(force) {
  const open = force ?? !root.classList.contains('reading');
  root.classList.toggle('reading', open); wordsBtn.setAttribute('aria-expanded', String(open));
  // closed, its controls leave the Tab order (the text stays in the page for screen readers' browse mode)
  closeBtn.tabIndex = open ? 0 : -1;
  if (open) { read.setAttribute('tabindex', '-1'); read.focus(); } else wordsBtn.focus({ preventScroll: true });
}
wordsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleWords(); });
$('#read-close').addEventListener('click', () => toggleWords(false));
read.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleWords(false); });
$('#skip').addEventListener('click', (e) => { e.preventDefault(); toggleWords(true); });

// ---------- WebGL2, or the still picture
let gl = null;
try { gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('capture') }); } catch {}
if (!gl || Q.has('nogl')) { root.classList.add('nogl'); throw new Error('no WebGL2: the still picture is shown'); }

// ---------- How much this device can draw
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpu = String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) || matchMedia('(pointer: coarse)').matches;
const soft = /swiftshader|llvmpipe|softpipe|software/i.test(gpu);
let tier = /mali-[4t]|adreno \(tm\) [345]\d\d|powervr|sgx/i.test(gpu) || soft ? 'low'
  : !mobile && /nvidia|geforce|rtx|quadro|radeon|apple m\d|apple gpu|arc/i.test(gpu) ? 'high' : 'mid';
if (/^(low|mid|high)$/.test(Q.get('tier') || '')) tier = Q.get('tier');
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const TIER = {
  high: { tiles: 2800, scale: Math.min(DPR, 1.6), oct: 4, bloom: 4, field: 160 },
  mid: { tiles: 1500, scale: Math.min(DPR, 1.25), oct: 3, bloom: 3, field: 128 },
  low: { tiles: 760, scale: soft ? 0.6 : Math.min(DPR, 1), oct: 2, bloom: 2, field: 96 },
}[tier];
let scale = TIER.scale;
root.dataset.tier = tier;

const floatRT = !!gl.getExtension('EXT_color_buffer_float');
gl.getExtension('OES_texture_float_linear');
const HDR = floatRT ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
const SCAL = floatRT ? { internal: gl.R16F, format: gl.RED, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };

// ---------- The wall
const wall = buildWall(TIER.tiles, 7);
const N = wall.count;
const D = wall.data;
const tilesTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tilesTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, STRIDE / 4, N, 0, gl.RGBA, gl.FLOAT, D);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
const peerFillT = wall.peers.map((ti) => D[ti * STRIDE + 17]);
const slowWall = [D[wall.peers[SLOW] * STRIDE], D[wall.peers[SLOW] * STRIDE + 1]];

// ---------- Programs
const P = {
  tile: program(gl, S.TILE_VS, S.TILE_FS.replace('FBM_N', String(TIER.oct)), 'tile'),
  link: program(gl, S.LINK_VS, S.LINK_FS, 'link'),
  ground: program(gl, S.QUAD_VS, S.GROUND_FS, 'ground'),
  bright: program(gl, S.QUAD_VS, S.BRIGHT_FS, 'bright'),
  down: program(gl, S.QUAD_VS, S.DOWN_FS, 'down'),
  up: program(gl, S.QUAD_VS, S.UP_FS, 'up'),
  comp: program(gl, S.QUAD_VS, S.COMPOSITE_FS, 'comp'),
  field: program(gl, S.QUAD_VS, S.FIELD_FS, 'field'),
};
const blit = fullscreen(gl);

// tile quad
const quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const tileVao = gl.createVertexArray(); gl.bindVertexArray(tileVao);
const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const linkVao = gl.createVertexArray(); gl.bindVertexArray(linkVao);
gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
const lb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, lb); gl.bufferData(gl.ARRAY_BUFFER, wall.links, gl.STATIC_DRAW);
gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(1, 1);
gl.bindVertexArray(null);

// a black 1x1 texture stands in for the pointer's field when there is none
const black = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, black);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

// ---------- Targets (rebuilt on resize)
let W = 1, H = 1, scene, bloom = [], fld = null;
function build() {
  const cw = Math.max(1, Math.round(innerWidth * scale)), ch = Math.max(1, Math.round(innerHeight * scale));
  canvas.width = cw; canvas.height = ch; W = cw; H = ch;
  scene?.free(); bloom.forEach((b) => b.free()); bloom = [];
  scene = target(gl, W, H, { ...HDR, depth: true });
  let w = W >> 1, h = H >> 1;
  for (let i = 0; i < TIER.bloom + 1; i++) { bloom.push(target(gl, Math.max(1, w), Math.max(1, h), HDR)); w >>= 1; h >>= 1; }
  if (!fld && !reduced) { const fw = TIER.field, fh = Math.round(TIER.field * 0.62); fld = { w: fw, h: fh, f: pair(gl, fw, fh, SCAL) }; if (!fld.f.ok) fld = null; }
  const hd = Math.min(DPR, 2);
  hud.width = Math.round(innerWidth * hd); hud.height = Math.round(innerHeight * hd);
}
build();

// ---------- State
const st = {
  p: reduced ? 1 : 0, target: reduced ? 1 : 0, vel: 0, hold: 0, holding: false, started: reduced, time: 0, film: 4, filmRate: 1, last: performance.now(),
  mx: 0.5, my: 0.5, smx: 0.5, smy: 0.5, vx: 0, vy: 0, lag: 0, travel: 0, touch: false, waveT: -100, waveO: [0, 0], waveAmp: 1,
  flash: 0, pings: [], intro: reduced ? 0 : 1, wait: 0, waitT: 0, buffer: 0, hopsDone: 0, arrived: 0,
  // the opening: 'wait' (dark, the loading line, then the prompt), 'play' (the ident), 'done'
  ident: reduced ? 'done' : 'wait', identAsked: -1, identT: 0, loadShown: 0,
};
const IDENT = 4.2; // seconds: the playhead draws (0 to 0.6), tan (0.6), the mark lights, DEM (1.4), it breaks apart (2.4 on)
// The score starts loading as soon as the page opens, so the opening is ready, even on a slow network, by the time
// someone presses.
if (!reduced) loadScore(SCORE).catch(() => {});
const sound = new Sound(SCORE);
// The sound must never stop the picture: an error in it is reported once and the frame carries on.
let soundErr = false;
const safe = (fn) => { try { fn(); } catch (e) { if (!soundErr) { soundErr = true; console.error('sound:', e); } } };
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function acts(p) {
  const together = ss(0.47, 0.585, p);
  const arrive = HANDLES.map((_, k) => (k === 0 ? 1 : ss(0.165 + (k - 1) * 0.0115, 0.193 + (k - 1) * 0.0115, p)));
  return {
    join: ss(0.075, 0.155, p),
    arrive,
    fill: ss(0.27, 0.355, p),
    assemble: Math.max(ss(0.43, 0.575, p), st.hold * 0.42 * (1 - ss(0.43, 0.575, p)) * ss(0.36, 0.43, p)),
    desync: 1 - Math.max(together, st.hold * 0.9),
    together,
    mesh: ss(0.49, 0.57, p) * (1 - ss(0.9, 0.97, p)),
    hostGone: ss(0.73, 0.83, p),
    newHost: ss(0.8, 0.86, p) * (1 - ss(0.93, 0.98, p)),
    merge: ss(0.87, 0.95, p),
    out: ss(0.85, 0.94, p),
    mark: ss(0.89, 0.97, p),
    words: ss(0.92, 0.99, p),
  };
}

// The opening, as overrides of the acts: the mark, dark, lights screen by screen (the playhead first, the late
// dot last, on the second hit), holds, then breaks apart into the room of dark screens where the piece begins.
function identActs(A, q) {
  const brk = ss(0.57, 1, q);
  A.mark = 1 - ss(0.57, 0.72, q); A.merge = 1 - ss(0.57, 0.8, q); A.assemble = 1 - ss(0.6, 1, q);
  A.out = 1 - ss(0.62, 0.92, q); A.fill = 1 - ss(0.7, 0.98, q); A.join = 1 - ss(0.8, 1, q);
  A.mesh = 0; A.words = 0; A.hostGone = 0; A.newHost = 0; A.desync = 0; A.together = 1;
  A.arrive = A.arrive.map((v, k) => (k === 0 ? 1 : 1 - ss(0.62, 0.9, q)));
  A.identOn = Math.min(1, Math.max(0, (q * IDENT - 0.55) / 0.85)); // 0 at 0.55 s, the dot (0.97) at 1.4 s
  A.identMode = 1 - ss(0.57, 0.66, q);
  A.identBreak = brk;
  return A;
}

// The camera's path: keyframes of eye, look and roll, eased between with Catmull-Rom.
function camera(p, aspect) {
  const fov = 40 * Math.PI / 180, tn = Math.tan(fov / 2);
  const Dw = Math.max(80, 62 / aspect) / tn;               // the wall fills the view
  const portrait = aspect < 0.9;
  const markH = portrait ? 96 / 0.5 : 96 / 0.6;
  const Dm = Math.max(markH / 2, (portrait ? 64 : 0) / aspect) / tn;
  const vw = Dm * tn * aspect, vh = Dm * tn;
  const mx = portrait ? 0 : vw * 0.36, my = portrait ? -vh * 0.34 : 0;
  const far = portrait ? 1.5 : 1;
  const [sx, sy] = slowWall;
  const K = [
    [0.0, [0, 0, 1350 * far], [0, 0, 0], 0],
    [0.07, [0, 0, 1250 * far], [0, 0, 60], 0],
    [0.155, [0, 0, 1050 * far], [0, 0, 120], 0],
    [0.26, [10, -6, 900 * far], [0, 0, 140], -0.02],
    [0.355, [-24, 14, 720 * far], [10, -4, 120], -0.05],
    [0.43, [30, -10, 470], [-6, 4, 0], 0.05],
    [0.52, [6, 0, Dw * 1.45], [0, 0, 0], 0.01],
    [0.6, [-38, -26, Dw * 0.95], [8, 6, 0], -0.02],
    [0.665, [sx * 0.6, sy * 0.6, Dw * 0.8], [sx * 0.8, sy * 0.8, 0], 0.015],
    [0.76, [-34, 20, Dw * 0.8], [-26, 22, 0], -0.035],
    [0.84, [0, -4, Dw * 1.08], [0, 0, 0], 0.012],
    [0.93, [mx, my, Dm * 1.05], [mx, my, 0], 0],
    [1.0, [mx, my, Dm], [mx, my, 0], 0],
  ];
  let i = 0; while (i < K.length - 2 && p > K[i + 1][0]) i++;
  const a = K[Math.max(0, i - 1)], b = K[i], c = K[i + 1], d = K[Math.min(K.length - 1, i + 2)];
  let t = (p - b[0]) / (c[0] - b[0]); t = Math.min(1, Math.max(0, t)); t = t * t * (3 - 2 * t);
  const cr = (p0, p1, p2, p3) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const eye = [0, 1, 2].map((k) => cr(a[1][k], b[1][k], c[1][k], d[1][k]));
  const look = [0, 1, 2].map((k) => cr(a[2][k], b[2][k], c[2][k], d[2][k]));
  const roll = cr(a[3], b[3], c[3], d[3]);
  return { eye, look, roll, fov, Dm };
}

// ---------- Input: no page scrolls; the wheel, a drag, the keys and the rail move one value along the piece.
const askIdent = () => { if (st.ident === 'wait' && st.identAsked < 0) st.identAsked = st.time; };
const setTarget = (v) => {
  if (st.ident !== 'done') { askIdent(); return; } // the opening plays first; scrolling starts it too
  st.target = Math.min(1, Math.max(0, v)); st.idle = 0;
  if (reduced) { st.p = st.target; requestAnimationFrame(frame); } // the calm version: a cut to the next still, no motion
};
const begin = () => {
  askIdent();
  if (!st.started) st.started = true;
  if (!sound.on && !sound.muted) { sound.start(); soundBtn.setAttribute('aria-pressed', 'true'); soundBtn.querySelector('.say').textContent = 'Sound on'; }
  soundBtn.hidden = false; root.classList.add('started');
};
addEventListener('wheel', (e) => {
  if (e.target.closest && e.target.closest('#read')) return;
  e.preventDefault(); const raw = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  const d = e.deltaMode === 1 ? raw * 32 : e.deltaMode === 2 ? raw * innerHeight : raw;
  setTarget(st.target + d * 0.00026); st.started = true;
}, { passive: false });
let down = null;
stage.addEventListener('pointerdown', (e) => {
  begin(); down = { x: e.clientX, y: e.clientY, t: performance.now(), p: st.target, moved: false, type: e.pointerType };
  st.holding = true; stage.setPointerCapture?.(e.pointerId);
});
addEventListener('pointermove', (e) => {
  st.touch = e.pointerType === 'touch';
  st.mx = e.clientX / innerWidth; st.my = e.clientY / innerHeight;
  if (down) {
    const ddy = e.clientY - down.y;
    if (Math.abs(ddy) > 8 || Math.abs(e.clientX - down.x) > 8) down.moved = true;
    if (down.type !== 'mouse' && down.moved) { setTarget(down.p - ddy / innerHeight * 0.5); st.holding = false; }
  }
  root.classList.toggle('pointer', !st.touch);
});
const up = () => {
  if (down && !down.moved && performance.now() - down.t < 220) ping(st.mx, st.my);
  down = null; st.holding = false;
};
addEventListener('pointerup', up); addEventListener('pointercancel', up);
addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('#read')) { if (e.key === 'Escape') toggleWords(false); return; }
  const k = e.key; const step = 0.03;
  if (k === ' ' || k === 'Enter') { if (e.target.closest && e.target.closest('a, button')) return; e.preventDefault(); begin(); st.holding = true; }
  else if (k === 'ArrowDown' || k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); setTarget(st.target + (k === 'PageDown' ? 0.1 : step)); st.started = true; }
  else if (k === 'ArrowUp' || k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); setTarget(st.target - (k === 'PageUp' ? 0.1 : step)); st.started = true; }
  else if (k === 'Home') { e.preventDefault(); setTarget(0); } else if (k === 'End') { e.preventDefault(); setTarget(1); st.started = true; }
  else if (k === 'm' || k === 'M') toggleSound();
  else if (k === 'w' || k === 'W') toggleWords();
  else if (k >= '1' && k <= '9') { const a = ACTS[+k - 1], nx = ACTS[+k] ? ACTS[+k][2] : 1; setTarget(k === '1' ? 0 : a[2] + (nx - a[2]) * 0.55); st.started = true; }
});
addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') st.holding = false; });
addEventListener('blur', () => { st.holding = false; down = null; });

// the rail: the timeline of the piece on the right edge, a real slider
const railSet = (e) => { const r = rail.getBoundingClientRect(); setTarget((e.clientY - r.top) / r.height); st.started = true; };
rail.addEventListener('pointerdown', (e) => { e.stopPropagation(); begin(); railSet(e); rail.setPointerCapture(e.pointerId); rail.onpointermove = railSet; });
rail.addEventListener('pointerup', () => { rail.onpointermove = null; });

// sound and words
function toggleSound(force) {
  const on = force ?? (sound.muted || !sound.on);
  if (on) { sound.start(); sound.setMuted(false); } else sound.setMuted(true);
  soundBtn.setAttribute('aria-pressed', String(on)); soundBtn.hidden = false;
  soundBtn.querySelector('.say').textContent = on ? 'Sound on' : 'Sound off';
}
soundBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSound(); });

// a click: a signal sent from where you are, a ripple through the wall and a bell on the beat
function ping(x, y) {
  if (CAP === 'rec') capPings.push([x, y]);
  st.pings.push({ x, y, t: st.time });
  safe(() => sound.tick((x - 0.5) * 1.4));
  const hit = unproject(x, y); if (hit) { st.waveT = st.time; st.waveO = hit; st.waveAmp = 0.5; }
}
let VP = new Float32Array(16), camNow = null;
function unproject(x, y) {
  if (!camNow) return null;
  const { eye, look, fov } = camNow; const aspect = innerWidth / innerHeight;
  const f = [look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]; const l = Math.hypot(...f); f[0] /= l; f[1] /= l; f[2] /= l;
  const tn = Math.tan(fov / 2); const nx = (x * 2 - 1) * tn * aspect, ny = (1 - y * 2) * tn;
  // the camera here looks almost straight down -z, so a flat approximation is close enough for a ripple's origin
  const t = -eye[2] / (f[2] || -1);
  return [eye[0] + (f[0] + nx) * t, eye[1] + (f[1] + ny) * t];
}

// ---------- The pointer: a weighted follower, and the lateness it leaves behind
let fieldPrev = null;
function pointerStep(dt) {
  // a critically damped spring: immediate, weighted, never jittery
  const k = 220, c = 2 * Math.sqrt(k);
  st.vx += ((st.mx - st.smx) * k - st.vx * c) * dt; st.vy += ((st.my - st.smy) * k - st.vy * c) * dt;
  st.smx += st.vx * dt; st.smy += st.vy * dt;
  const sp = Math.hypot(st.vx * innerWidth, st.vy * innerHeight); // px per second
  st.lag += (Math.min(1, sp / 1400) - st.lag) * (1 - Math.exp(-dt * 6));
  // a note now and then as the pointer crosses the wall: by how far it travels against the screen's size (so a big
  // screen plays no more than a small one), only while moving briskly, and never over the mark at the end
  if (!st.touch && root.classList.contains('pointer')) {
    const diag = Math.hypot(innerWidth, innerHeight);
    st.travel += sp * dt / diag;
    if (st.travel > 0.35 && sp > diag * 0.25 && st.p > 0.27 && st.p < 0.86) { st.travel = 0; safe(() => sound.pointerNote(st.smx, st.smy, sp / (diag * 1.5))); }
  }
  if (!fld) return;
  const cur = [st.smx, 1 - st.smy];
  const a = fieldPrev || cur; fieldPrev = cur;
  const amt = st.touch || !root.classList.contains('pointer') ? 0 : ss(60, 900, sp) * 0.95;
  gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
  P.field.use().tex('uSrc', fld.f.read.t).f('uA', a[0], a[1]).f('uB', cur[0], cur[1]).f('uDecay', Math.pow(0.18, dt)).f('uAmt', amt)
    .f('uRadius', 0.0016).f('uAspect', innerWidth / innerHeight);
  blit(fld.f.write.fb, fld.w, fld.h); fld.f.swap();
}

// ---------- HUD: the people, the room clock, the rail, the cursor
const hx = hud.getContext('2d');
{ const fill = hx.fillText.bind(hx);
  hx.fillText = (t, x, y) => { const f = hx.fillStyle; if (f !== '#07040f') { const l = hx.lineWidth; hx.strokeStyle = 'rgba(7,4,15,.85)'; hx.lineWidth = 3; hx.strokeText(t, x, y); hx.lineWidth = l; } fill(t, x, y); }; } // dark words on a badge need no edge
const MONO = '"Tandem Mono", ui-monospace, monospace';
const SANS = '"Tandem Sans", system-ui, sans-serif';
const tc = (s) => { s = Math.max(0, s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = Math.floor(s) % 60, ms = Math.floor((s % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.${String(ms).padStart(3, '0')}`; };
const cpos = new Float32Array(3);
const BOOT = [['SCREENS', 'WARMING UP', '#9184bc'], ['REMOTE', 'SHARED', '#00f0ff'], ['SPOILERS', 'NONE FOUND', '#00f0ff'], ['SNACKS', 'NOT DETECTED', '#ff2a6d'], ['CLOCKS', 'EIGHT, DRIFTING', '#ff2a6d']];
const toScreen = (x, y, z, w, h) => { const [sx, sy, sw] = project(VP, x, y, z); return [(sx * 0.5 + 0.5) * w, (1 - (sy * 0.5 + 0.5)) * h, sw, sx, sy]; };
function drawHud(A, u) {
  const k = hud.width / innerWidth; const w = innerWidth, h = innerHeight;
  hx.setTransform(k, 0, 0, k, 0, 0); hx.clearRect(0, 0, w, h);
  hx.lineJoin = 'round';
  const small = w < 640;
  if (st.ident !== 'done') { drawOpening(w, h, small); drawCursor(A, w, h); return; }
  // the intro: the room clock and one line, a playhead through the middle
  if (st.intro > 0.001) {
    const a = st.intro;
    hx.globalAlpha = a;
    hx.fillStyle = '#00f0ff'; const lx = Math.round(small ? 22 : w * 0.5);
    const flick = 0.85 + 0.15 * Math.sin(st.time * 2.1);
    hx.globalAlpha = a * flick; hx.fillRect(lx - 1, 0, 2, h); hx.globalAlpha = a * 0.12; hx.fillRect(lx - 9, 0, 18, h);
    hx.globalAlpha = a; hx.fillStyle = '#ff2a6d'; hx.fillRect(lx - 12, h * 0.5 - 40, 3, 80);
    hx.fillStyle = '#efeaff'; hx.font = `700 ${small ? 22 : 34}px ${MONO}`; hx.textAlign = 'left'; hx.textBaseline = 'middle';
    hx.fillText(tc(st.film), lx + 18, h * 0.5);
    hx.font = `400 ${small ? 11 : 12}px ${MONO}`; hx.fillStyle = '#9184bc';
    hx.fillText('TANDEM', lx + 20, h * 0.5 - (small ? 26 : 34));
    const blink = (Math.sin(st.time * 3.2) > -0.3) ? 1 : 0.35;
    hx.globalAlpha = a * blink; hx.fillStyle = '#00f0ff';
    hx.fillText(st.started ? 'SCROLL, OR HOLD' : (mobile ? 'PRESS AND HOLD, THEN SWIPE' : 'PRESS AND HOLD ANYWHERE'), lx + 20, h * 0.5 + (small ? 26 : 36));
    // the app's own self-test, typed out while the room warms up
    hx.globalAlpha = a; hx.font = `400 ${small ? 9 : 10}px ${MONO}`;
    BOOT.forEach(([kk, v, c], i) => {
      const at = 0.6 + i * 0.45; if (st.time < at) return;
      const n = Math.min(1, (st.time - at) / 0.35); const line = `${kk.padEnd(12, '.')} ${v}`;
      hx.fillStyle = 'rgba(145,132,188,.85)'; hx.fillText(line.slice(0, Math.ceil(line.length * n)).slice(0, 13), lx + 20, h * 0.5 + (small ? 52 : 66) + i * 14);
      if (n >= 1) { hx.fillStyle = c; hx.fillText(v, lx + 20 + hx.measureText('x'.repeat(13)).width, h * 0.5 + (small ? 52 : 66) + i * 14); }
    });
    hx.textBaseline = 'alphabetic'; hx.globalAlpha = 1;
  }
  // the invite: one pink spark leaves the host's screen and hops screen to screen
  const inv = ss(0.0, 0.08, A.join) * (1 - ss(0.95, 1, A.join));
  if (inv > 0.01) {
    const T = wall.hopT, J = A.join * 1.02; let hI = 0; while (hI < T.length - 2 && J > T[hI + 1]) hI++;
    const pts = wall.hops.map((ti) => { tileCentre(D, ti, u, cpos); return toScreen(cpos[0], cpos[1], cpos[2], w, h); });
    const f = Math.min(1, Math.max(0, (J - T[hI]) / (T[hI + 1] - T[hI])));
    const e = f * f * (3 - 2 * f);
    const sx = pts[hI][0] + (pts[hI + 1][0] - pts[hI][0]) * e, sy = pts[hI][1] + (pts[hI + 1][1] - pts[hI][1]) * e;
    hx.globalAlpha = inv;
    hx.strokeStyle = 'rgba(255,42,109,.35)'; hx.lineWidth = 1; hx.beginPath(); hx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i <= hI; i++) hx.lineTo(pts[i][0], pts[i][1]);
    hx.lineTo(sx, sy); hx.stroke();
    // the spark: a small cut diamond and a soft glow
    const g = hx.createRadialGradient(sx, sy, 0, sx, sy, 22); g.addColorStop(0, 'rgba(255,42,109,.55)'); g.addColorStop(1, 'rgba(255,42,109,0)');
    hx.fillStyle = g; hx.fillRect(sx - 22, sy - 22, 44, 44);
    hx.fillStyle = '#ffd1df'; hx.beginPath(); hx.moveTo(sx, sy - 5); hx.lineTo(sx + 4, sy); hx.lineTo(sx, sy + 5); hx.lineTo(sx - 4, sy); hx.closePath(); hx.fill();
    hx.globalAlpha = 1;
  }
  // the people: each name beside its screen, and what this act says about them
  const lab = ss(0.65, 1, 1 - st.intro) * (1 - A.mark);
  if (lab > 0.01) {
    hx.font = `400 ${small ? 10 : 11}px ${MONO}`; hx.textAlign = 'left'; hx.textBaseline = 'alphabetic';
    const placed = []; let near = null;
    const now = new Date();
    wall.peers.forEach((ti, i) => {
      if (A.arrive[i] < 0.02) return;
      tileCentre(D, ti, i === 0 && A.hostGone > 0.25 ? { ...u, hostGone: 0 } : u, cpos);
      const [px, py, sw, sx, sy] = toScreen(cpos[0], cpos[1], cpos[2], w, h);
      if (sw < 1 || Math.abs(sx) > 1.1 || Math.abs(sy) > 1.1) return;
      const o = D[ti * STRIDE + 14] * Math.min(1, Math.max(0, A.desync * 1.25 - D[ti * STRIDE + 13] * 0.25));
      const ms = o * 1000 + Math.sin(st.time * 1.7 + i * 2.1) * 2.4 * (0.3 + 0.7 * A.together);
      const isHost = (i === 0 && A.hostGone < 0.05) || (i === 1 && A.newHost > 0.5);
      const left = i === 0 && A.hostGone >= 0.05;
      let al = lab * Math.min(1, 600 / Math.max(600, sw * 0.5)) * (i === 0 ? 1 : ss(0.6, 1, A.arrive[i]));
      if (left) al *= ss(0.25, 0.4, A.hostGone) * (1 - ss(0.8, 0.86, st.p));
      if (al < 0.02) return;
      hx.globalAlpha = al;
      let lx = px + 14, ly = py - 14;
      const flip = lx + 190 > w - 56; if (flip) lx = Math.max(8, px - 14 - 190);
      for (let kk = 0; kk < 6 && placed.some(([x, y]) => Math.abs(x - lx) < 150 && Math.abs(y - ly) < 34); kk++) ly += 34;
      placed.push([lx, ly]);
      if (Math.hypot(px - st.smx * w, py - st.smy * h) < 70 && !mobile && st.p > 0.36) near = { i, px, py, ms, isHost, left };
      hx.strokeStyle = 'rgba(145,132,188,.7)'; hx.lineWidth = 1; hx.beginPath(); hx.moveTo(px, py); const ex = flip ? lx + 186 : lx - 6; hx.lineTo(ex, ly - 3); hx.lineTo(ex + (flip ? -3 : 3), ly - 3); hx.stroke();
      hx.fillStyle = '#00f0ff'; hx.fillRect(px - 2, py - 2, 4, 4);
      hx.fillStyle = '#efeaff'; hx.fillText(HANDLES[i], lx, ly);
      let x2 = lx + hx.measureText(HANDLES[i]).width + 8;
      if (isHost) { hx.fillStyle = '#ff2a6d'; hx.fillRect(x2, ly - 9, 32, 12); hx.fillStyle = '#07040f'; hx.fillText('HOST', x2 + 3, ly); x2 += 40; }
      // the second line: what this moment says about them
      let line = '', col = '#9184bc', line2 = '';
      const fillI = i === 0 ? 1 : Math.min(1, Math.max(0, (A.fill - peerFillT[i]) / 0.07));
      if (left) { hx.fillStyle = '#ff2a6d'; hx.fillText('LEFT THE ROOM', x2, ly); }
      else if (st.p < 0.16) { if (i === 0) { line = 'SENT AN INVITE'; col = '#ff2a6d'; } }
      else if (st.p < 0.265) {
        const [city, local] = PLACES[i]; const tm = fmt[i] ? fmt[i].format(now) : '';
        line = `${local} ${tm}`; line2 = i === 0 ? '' : `+${Math.round(Math.abs(D[ti * STRIDE + 14]) * 1000)} ms`;
        void city;
      } else if (st.p < 0.36) {
        if (i === 0) { line = 'HAS THE FILM'; col = '#00f0ff'; }
        else if (fillI >= 1) { line = 'READY'; col = '#00f0ff'; } else { line = `STREAMING ${Math.round(fillI * 100)}%`; }
      } else if (st.wait === 1) {
        if (i === SLOW) { line = `BUFFERING ${Math.round(Math.min(1, (st.time - st.waitT) / 3) * 100)}%`; col = '#ff2a6d'; } else line = 'WAITING';
      } else {
        const late = Math.abs(ms) > 40;
        hx.fillStyle = late ? '#ff2a6d' : '#9184bc';
        hx.fillText(`${ms >= 0 ? '+' : '-'}${Math.abs(ms).toFixed(1)} ms`, lx, ly + 14);
        hx.fillStyle = late ? '#ff2a6d' : '#00f0ff';
        hx.fillText(late ? 'CATCHING UP' : 'IN SYNC', lx + 82, ly + 14);
      }
      if (line) {
        hx.font = `400 ${small ? 10 : 11}px ${/[^\x00-ɏ]/.test(line) ? SANS : MONO}`;
        hx.fillStyle = col; hx.fillText(line, lx, ly + 14);
        if (line2) { const lw = hx.measureText(line).width; hx.font = `400 ${small ? 10 : 11}px ${MONO}`; hx.fillStyle = '#ff2a6d'; hx.fillText(line2, lx + lw + 10, ly + 14); }
        hx.font = `400 ${small ? 10 : 11}px ${MONO}`;
      }
    });
    hx.globalAlpha = 1;
    if (near && !near.left) stationCard(near, lab);
  }
  // the room clock, bottom left
  const clockA = ss(0.65, 1, 1 - st.intro) * (1 - A.words);
  if (clockA > 0.01) {
    hx.globalAlpha = clockA; hx.font = `700 ${small ? 10 : 11}px ${MONO}`;
    const x = small ? 16 : 28, y = h - (small ? 22 : 28);
    hx.fillStyle = st.wait === 1 ? '#ff2a6d' : '#00f0ff'; cutRect(x, y - 13, 96, 18, 4); hx.fill();
    hx.fillStyle = '#07040f'; hx.fillText('ROOM CLOCK', x + 8, y);
    hx.fillStyle = '#efeaff'; hx.font = `400 ${small ? 11 : 12}px ${MONO}`; hx.fillText(tc(st.film), x + 106, y);
    if (!small) {
      const here = A.arrive.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0) - (A.hostGone > 0.5 ? 1 : 0);
      let t2 = '', c2 = '#9184bc';
      if (st.wait === 1) { t2 = `paused  ·  waiting for ${HANDLES[SLOW]}`; c2 = '#ff2a6d'; }
      else if (st.p < 0.16) t2 = 'invite sent  ·  peer to peer, no server in the middle';
      else if (st.p < 0.36) t2 = `${here} of 8 here  ·  one copy of the film is enough`;
      else { const spread = Math.round(A.desync * 2400); t2 = `spread ${spread} ms  ·  ${here} stations, each linked to every other`; c2 = spread > 40 ? '#ff2a6d' : '#9184bc'; }
      hx.fillStyle = c2; hx.fillText(t2, x + 220, y);
    }
    hx.globalAlpha = 1;
  }
  // the rail
  const rx = w - (small ? 14 : 26), r0 = h * 0.14, r1 = h * 0.86;
  hx.globalAlpha = 0.9 * (1 - A.words * 0.6);
  hx.fillStyle = 'rgba(145,132,188,.35)'; hx.fillRect(rx, r0, 1, r1 - r0);
  hx.font = `400 10px ${MONO}`; hx.textAlign = 'right'; hx.textBaseline = 'middle';
  ACTS.forEach(([n, name, at], i) => {
    const y = r0 + (r1 - r0) * at; const next = ACTS[i + 1] ? ACTS[i + 1][2] : 1.01;
    const here = st.p >= at - 0.001 && st.p < next;
    hx.fillStyle = here ? '#00f0ff' : 'rgba(145,132,188,.8)'; hx.fillRect(rx - 4, y, 9, 1);
    if (!small || here) hx.fillText(here ? `${n} ${name.toUpperCase()}` : n, rx - 10, y);
  });
  const py2 = r0 + (r1 - r0) * st.p;
  hx.fillStyle = '#00f0ff'; hx.fillRect(rx - 1, r0, 3, py2 - r0); hx.fillStyle = '#ff2a6d'; hx.fillRect(rx - 6, py2 - 1, 13, 3);
  hx.textAlign = 'left'; hx.textBaseline = 'alphabetic'; hx.globalAlpha = 1;
  drawCursor(A, w, h);
  // signals from a click, drawn as two widening open arcs (never a whole circle)
  for (const pg of st.pings) {
    const age = st.time - pg.t; if (age > 1.4) continue; const r = 10 + age * 180;
    hx.strokeStyle = `rgba(0,240,255,${(1 - age / 1.4) * 0.6})`; hx.lineWidth = 1;
    for (let q = 0; q < 2; q++) { const a0 = q * Math.PI + 0.5 + age * 0.6; hx.beginPath(); hx.arc(pg.x * w, pg.y * h, r, a0, a0 + 1.1); hx.stroke(); }
  }
  st.pings = st.pings.filter((pg) => st.time - pg.t < 1.4);
}
// the cursor: a small playhead, and a pink late mark beside it that falls back into it as you slow down
function drawCursor(A, w, h) {
  if (root.classList.contains('pointer') && !st.touch && !mobile) {
    const x = Math.round(st.smx * w), y = Math.round(st.smy * h);
    const lagPx = 2 + st.lag * 14;
    hx.fillStyle = '#ff2a6d'; hx.globalAlpha = 0.25 + 0.75 * st.lag; hx.fillRect(x - lagPx - 1, y - 6, 1.5, 12);
    hx.globalAlpha = 1; hx.fillStyle = '#00f0ff'; hx.fillRect(x - 0.75, y - 8, 1.5, 16);
    if (st.holding && A.words < 0.5 && st.ident === 'done') {
      hx.fillStyle = 'rgba(0,240,255,.8)'; hx.fillRect(x + 6, y + 6, 40 * st.hold, 1);
      hx.font = `400 9px ${MONO}`; hx.fillStyle = 'rgba(239,234,255,.75)'; hx.fillText(`syncing ${Math.round(st.hold * 100)}%`, x + 6, y - 4);
    }
  }
}
// The opening's screen: dark, one cyan playhead line that grows as the score loads (with how far it has got, in
// words), then the prompt; once pressed, the line reaches its full height and hands over to the mark's own playhead.
function drawOpening(w, h, small) {
  const [px] = (() => { const [sx] = project(VP, -1.5, 0, 0); return [(sx * 0.5 + 0.5) * w]; })();
  const x = Number.isFinite(px) ? px : w / 2, cy = h * 0.5, full = h * 0.36;
  const loaded = CAP ? 1 : Math.min(1, progress.done / progress.total);
  st.loadShown += (loaded - st.loadShown) * 0.12;
  const q = st.ident === 'play' ? (st.time - st.identT) / IDENT : 0;
  const grow = st.ident === 'play' ? 1 : 0.15 + 0.85 * st.loadShown;
  const len = full * (st.ident === 'play' ? Math.min(1, st.loadShown + ss(0, 0.14, q)) : grow);
  const fade = st.ident === 'play' ? 1 - ss(0.12, 0.2, q) : 1;
  if (fade > 0.01) {
    hx.globalAlpha = fade * 0.18; hx.fillStyle = '#00f0ff'; hx.fillRect(x - 6, cy - len / 2, 12, len);
    hx.globalAlpha = fade; hx.fillRect(x - 1, cy - len / 2, 2, len);
  }
  if (st.ident === 'wait') {
    hx.font = `400 ${small ? 10 : 11}px ${MONO}`; hx.textAlign = 'center'; hx.textBaseline = 'alphabetic';
    const ready = !!progress.ident || CAP;
    const label = st.identAsked >= 0 || !ready ? `LOADING  ${Math.round(st.loadShown * 100)}%` : (mobile ? 'TAP ANYWHERE' : 'PRESS ANYWHERE');
    hx.globalAlpha = ready && st.identAsked < 0 ? 0.65 + 0.35 * Math.sin(st.time * 2.2) : 0.75;
    const ty = Math.min(h - 40, cy + h * 0.36); // below the mark
    hx.fillStyle = '#efeaff'; hx.fillText(label.split('').join(String.fromCharCode(8202)), x, ty);
    hx.globalAlpha = 0.5; hx.fillStyle = '#9184bc'; hx.fillText(ready ? 'WITH SOUND' : 'TANDEM', x, ty + 18);
    hx.textAlign = 'left';
  }
  hx.globalAlpha = 1;
}
// Hovering a named screen opens its card from the app's Stations panel: the same badges, offset bar and rates.
function stationCard(n, alpha) {
  const w = 236, h = 118; let x = n.px + 22, y = n.py + 18;
  if (x + w > innerWidth - 40) x = n.px - w - 22; if (y + h > innerHeight - 50) y = n.py - h - 18;
  x = Math.max(8, Math.min(innerWidth - w - 8, x)); y = Math.max(8, y);
  const late = Math.abs(n.ms) > 40;
  hx.globalAlpha = alpha;
  hx.fillStyle = 'rgba(16,9,32,.92)'; cutRect(x, y, w, h, 10); hx.fill();
  hx.strokeStyle = 'rgba(0,240,255,.45)'; hx.lineWidth = 1; cutRect(x + .5, y + .5, w - 1, h - 1, 10); hx.stroke();
  hx.font = `700 12px ${MONO}`; hx.fillStyle = '#efeaff'; hx.fillText(HANDLES[n.i], x + 12, y + 20);
  if (n.isHost) { hx.fillStyle = '#ff2a6d'; cutRect(x + w - 50, y + 9, 40, 14, 3); hx.fill(); hx.fillStyle = '#07040f'; hx.font = `700 10px ${MONO}`; hx.fillText('HOST', x + w - 44, y + 20); }
  hx.font = `700 9px ${MONO}`;
  const badge = (bx, label, on) => { const bw = hx.measureText(label).width + 12; hx.fillStyle = on ? '#00f0ff' : 'rgba(255,42,109,.9)'; cutRect(bx, y + 30, bw, 14, 3); hx.fill(); hx.fillStyle = '#07040f'; hx.fillText(label, bx + 6, y + 40); return bx + bw + 6; };
  const bx = badge(x + 12, 'SAME FILE', true); badge(bx, late ? 'CATCHING UP' : 'IN SYNC', !late);
  const bx0 = x + 12, bw0 = w - 24, mid = bx0 + bw0 / 2; hx.fillStyle = 'rgba(145,132,188,.35)'; hx.fillRect(bx0, y + 56, bw0, 3);
  hx.fillStyle = 'rgba(239,234,255,.7)'; hx.fillRect(mid, y + 52, 1, 10);
  const mk = mid + Math.max(-1, Math.min(1, n.ms / 2500)) * bw0 / 2; hx.fillStyle = late ? '#ff2a6d' : '#00f0ff'; hx.fillRect(mk - 2, y + 54, 5, 7);
  hx.font = `400 10px ${MONO}`; hx.fillStyle = '#9184bc';
  const rtt = 1 + ((n.i * 7) % 5);
  hx.fillText(`${n.ms >= 0 ? '+' : '-'}${Math.abs(n.ms).toFixed(1)} ms   RTT ${rtt} ms`, x + 12, y + 80);
  const act = 1 - Math.max(-0.002, Math.min(0.002, n.ms / 400000)) + Math.sin(st.time * 2 + n.i) * 0.0004;
  hx.fillText(`Set 1.000×   Actual ${act.toFixed(3)}×`, x + 12, y + 98);
  hx.globalAlpha = 1;
}
function cutRect(x, y, w, h, c) { hx.beginPath(); hx.moveTo(x, y); hx.lineTo(x + w - c, y); hx.lineTo(x + w, y + c); hx.lineTo(x + w, y + h); hx.lineTo(x + c, y + h); hx.lineTo(x, y + h - c); hx.closePath(); }

// ---------- The closing words, arriving out of sync and locking in
const letters = [...finale.querySelectorAll('.ch')];
letters.forEach((l, i) => { l.style.setProperty('--r', Math.abs((Math.sin(i * 91.7 + 1.3) * 43758.5453) % 1).toFixed(3)); });
function drawWords(A) {
  const d = 1 - A.words;
  finale.style.setProperty('--d', d.toFixed(4));
  finale.style.opacity = String(ss(0.0, 0.35, A.words));
  finale.classList.toggle('on', A.words > 0.98);
  finale.style.visibility = A.words > 0.001 ? 'visible' : 'hidden';
}

// the sound button's glyph: the room's wave and the late one's, out of phase by how far apart the room is
const w1 = soundBtn.querySelector('.w1'), w2 = soundBtn.querySelector('.w2');
function drawWave(A) {
  if (soundBtn.hidden) return;
  // slow and low, so it never flickers; flat when muted
  const amp = sound.on && !sound.muted ? 1.5 + Math.min(1, sound.level * 10) * 2.5 : 0;
  const pts = (ph) => { let d = ''; for (let x = 0; x <= 44; x += 2) d += `${x ? 'L' : 'M'}${x} ${(8 + Math.sin(x * 0.3 + st.time * 1.4 + ph) * amp).toFixed(2)}`; return d; };
  w1.setAttribute('d', pts(0)); w2.setAttribute('d', pts(A.desync * 2.6));
}

// ---------- Frame
let ema = 16, lastAdapt = 0, frames = 0;
const fpsLog = [];
const stats = { frames: 0, slow: 0 };
window.__art = { sound, st, tier, gpu, get scale() { return scale; }, stats, fpsLog, N, links: wall.linkCount, acts: () => acts(st.p) };
let lastHostGone = 0, railShown = -1;
// Recording a session (?capture=rec): every frame advances exactly 1/30 s and logs its input, so the same
// session can be drawn again frame by frame (?capture=play) and its sound rendered offline, for a video.
// ?nodraw skips the drawing (for rendering the sound of a session only).
const CAP = Q.get('capture');
const NODRAW = Q.has('nodraw');
const MANUAL = Q.has('manual'); // a recording steps the page one frame at a time (__art.step), so it is exact
const capLog = [], soundLog = []; let capPings = [];
if (CAP === 'play') {
  for (const k of Object.getOwnPropertyNames(Sound.prototype)) {
    if (k === 'constructor' || typeof sound[k] !== 'function' || ['restart', 'nextGrid', 'shot', 'begin'].includes(k)) continue;
    sound[k] = (...a) => { soundLog.push([stats.frames, k, JSON.parse(JSON.stringify(a))]); if (k === 'start') sound.on = true; if (k === 'setMuted') { sound.muted = a[0]; sound.on = true; } };
  }
}
let lastDraw = 0;
function frame(now) {
  // the lowest tier draws a steady 30 a second rather than an uneven 40 (Active Theory caps low tiers the same way)
  if (tier === 'low' && !CAP && !reduced && now - lastDraw < 31) { requestAnimationFrame(frame); return; }
  lastDraw = now;
  const t0 = performance.now();
  let dt = Math.min(0.05, Math.max(0.001, (now - st.last) / 1000)); st.last = now;
  if (CAP) dt = 1 / 30;
  if (CAP === 'rec') capLog.push({ ask: st.identAsked >= 0, p: st.p, target: st.target, holding: st.holding, mx: st.mx, my: st.my, started: st.started, idle: st.idle, pings: capPings.splice(0), pointer: root.classList.contains('pointer'), audio: sound.on });
  if (!reduced && CAP !== 'play' && !MANUAL) requestAnimationFrame(frame);
  st.time += dt;
  const pv = st.p;
  st.p += (st.target - st.p) * (1 - Math.exp(-dt * 2.6));
  st.vel = (st.p - pv) / dt;
  // the film plays at its own speed and pauses while the room waits for the slowest
  st.filmRate += ((st.wait === 1 ? 0 : st.p > 0.86 ? 0.12 : 1) - st.filmRate) * (1 - Math.exp(-dt * 2)); // and slows to almost still under the mark
  st.film += dt * st.filmRate * (1 + Math.min(2, Math.abs(st.vel) * 6));
  // nobody touching anything for a while: drift on by itself, slowly (but never while the room holds its breath)
  st.idle = (st.idle || 0) + dt;
  if (st.started && st.idle > 9 && st.target < 0.995 && st.wait !== 1) st.target = Math.min(1, st.target + dt * 0.011);
  st.hold = Math.min(1, Math.max(0, st.hold + (st.holding ? dt * 0.9 : -dt * 0.45)));
  if (st.holding) st.idle = 0;
  st.intro = reduced ? 0 : 1 - ss(0.0, 0.07, st.p);
  // the opening: wait for a press (and for the ident's sound, briefly), play it, then let the piece begin
  if (st.ident === 'wait' && st.identAsked >= 0 && (progress.ident || CAP || st.time - st.identAsked > 6)) {
    st.ident = 'play'; st.identT = st.time; safe(() => sound.ident());
  }
  if (st.ident === 'play' && st.time - st.identT >= IDENT) { st.ident = 'done'; st.started = true; st.idle = 0; st.hopsDone = 0; st.arrived = 0; }
  if (st.ident !== 'done') { st.p = 0; st.target = 0; st.intro = 1; }
  const q = st.ident === 'wait' ? 0 : st.ident === 'play' ? (st.time - st.identT) / IDENT : 1;
  const A = acts(st.p);
  A.identOn = 1; A.identMode = 0; A.identBreak = 1;
  if (st.ident !== 'done') identActs(A, q);
  if (reduced) { A.desync = 0; A.mesh = 0.35; }
  // waiting for the slowest: once the room is together, one friend buffers for three seconds and everyone waits
  if (!reduced) {
    if (st.wait === 0 && st.p > 0.62 && st.p < 0.71 && A.together > 0.95) { st.wait = 1; st.waitT = st.time; safe(() => sound.wait()); }
    else if (st.wait === 1 && (st.time - st.waitT > 3.0 || st.p > 0.715)) { st.wait = 2; safe(() => sound.release(true)); st.flash = 0.25; }
    else if (st.wait === 1 && st.p < 0.6) { st.wait = 0; safe(() => sound.release(false)); }
    else if (st.wait === 2 && st.p < 0.6) st.wait = 0;
  }
  st.buffer += ((st.wait === 1 ? 1 : 0) - st.buffer) * (1 - Math.exp(-dt * 4));
  // the host leaves
  if (lastHostGone < 0.05 && A.hostGone >= 0.05 && !reduced) { safe(() => sound.hostLeaves()); st.waveT = st.time; st.waveAmp = 1; const t = D.subarray(wall.host * STRIDE, wall.host * STRIDE + 2); st.waveO = [t[0], t[1]]; }
  if (lastHostGone >= 0.05 && A.hostGone < 0.02) safe(() => sound.hostBack());
  lastHostGone = A.hostGone;
  st.flash *= Math.exp(-dt * 2.5);

  // camera
  const aspect = innerWidth / innerHeight;
  const cam = camera(st.p, aspect);
  if (st.ident !== 'done') { // the opening frames the mark in the middle, then pulls back into the room
    const k = ss(0.57, 1, q), e = [0, 0, cam.Dm * 1.08];
    cam.eye = cam.eye.map((v, i) => e[i] + (v - e[i]) * k); cam.look = cam.look.map((v) => v * k); cam.roll *= k;
  }
  camNow = cam;
  pointerStep(dt);
  const par = reduced ? [0, 0] : [(st.smx - 0.5) * 2, (st.smy - 0.5) * 2];
  const sway = reduced ? 0 : (1 - st.buffer) * A.identBreak;
  const eye = [cam.eye[0] + par[0] * 6 + Math.sin(st.time * 0.13) * 3 * sway, cam.eye[1] - par[1] * 4 + Math.cos(st.time * 0.11) * 2 * sway, cam.eye[2]];
  const roll = cam.roll + par[0] * 0.01;
  const proj = perspective(cam.fov, aspect, 1, 4000);
  const view = lookAt(eye, cam.look, [Math.sin(roll), Math.cos(roll), 0]);
  VP = mul(proj, view);
  const u = { assemble: A.assemble, merge: A.merge, hostGone: A.hostGone, time: st.time, arrive: A.arrive };
  const fieldTex = fld ? fld.f.read.t : black;

  // the invite reaching each screen, and the friends landing: on the beat, in the sound
  if (!reduced && st.ident === 'done') {
    const J = A.join * 1.02; let reached = 0; while (reached < wall.hopT.length && J >= wall.hopT[reached] && A.join > 0) reached++;
    if (reached > st.hopsDone && st.vel >= 0) { tileCentre(D, wall.hops[reached - 1], u, cpos); const [sx] = project(VP, cpos[0], cpos[1], cpos[2]); safe(() => sound.hop(reached - 1, Math.max(-1, Math.min(1, sx)))); }
    st.hopsDone = reached;
    let arrived = 0; A.arrive.forEach((v, k) => { if (k && v > 0.97) arrived |= 1 << k; });
    for (let k = 1; k < 8; k++) if ((arrived & (1 << k)) && !(st.arrived & (1 << k)) && st.vel >= 0) {
      tileCentre(D, wall.peers[k], u, cpos); const [sx] = project(VP, cpos[0], cpos[1], cpos[2]); safe(() => sound.arrive(k, Math.max(-1, Math.min(1, sx))));
    }
    st.arrived = arrived;
  }

  if (!NODRAW) {
    // scene
    gl.bindFramebuffer(gl.FRAMEBUFFER, scene.fb); gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    P.ground.use().f('uRes', W, H).f('uPar', eye[0] * 0.002, eye[1] * 0.002 + eye[2] * 0.0004).f('uTime', st.time).f('uGlow', A.together);
    gl.bindVertexArray(null); blit(scene.fb, W, H);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const arr = new Float32Array(A.arrive);
    const common = (pr) => { pr.tex('uTiles', tilesTex).f('uTime', st.time).f('uAssemble', A.assemble).f('uMerge', A.merge).f('uOut', A.out)
      .f('uHostGone', A.hostGone).f('uWaveT', st.waveT).f('uWaveAmp', st.waveAmp).f('uWaveO', st.waveO[0], st.waveO[1]).m4('uVP', VP)
      .f('uJoin', A.join).f('uFill', A.fill); if (pr.u.uArrive != null) gl.uniform1fv(pr.u.uArrive, arr); return pr; };
    tileCentre(D, wall.host, u, cpos);
    common(P.tile.use()).tex('uFluid', fieldTex).f('uDesync', A.desync).f('uFluidK', 1 - A.mark).f('uBuffer', st.buffer).f('uHostPos', cpos[0], cpos[1], cpos[2])
      .f('uMark', A.mark).f('uFilmT', st.film).f('uFog', 0.0006).f('uNewHost', A.newHost).f('uFilmHue', 1).f('uLock', st.flash).f('uFrag', 0)
      .f('uIdent', A.identOn).f('uIdentMode', A.identMode).f('uCalm', Math.max(A.mark * (st.ident === 'done' ? 1 : 0), A.identMode));
    gl.bindVertexArray(tileVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, N);
    if (A.fill > 0 && A.fill < 1) { // the film streaming out from the one screen that has it
      gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE);
      P.tile.f('uFrag', 1); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, N);
      gl.depthMask(true); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    if (A.mesh > 0.01) {
      gl.depthMask(false); gl.blendFunc(gl.ONE, gl.ONE);
      common(P.link.use()).f('uRes', W * 0.5, H * 0.5).f('uPx', 1.4 * scale).f('uMesh', A.mesh);
      gl.bindVertexArray(linkVao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, wall.linkCount);
      gl.depthMask(true);
    }
    gl.bindVertexArray(null); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);

    // bloom
    P.bright.use().tex('uSrc', scene.t).f('uThresh', 0.85); blit(bloom[0].fb, bloom[0].w, bloom[0].h);
    for (let i = 1; i < bloom.length; i++) { P.down.use().tex('uSrc', bloom[i - 1].t).f('uTexel', 1 / bloom[i - 1].w, 1 / bloom[i - 1].h); blit(bloom[i].fb, bloom[i].w, bloom[i].h); }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = bloom.length - 1; i > 0; i--) { P.up.use().tex('uSrc', bloom[i].t).tex('uBase', black).f('uTexel', 1 / bloom[i].w, 1 / bloom[i].h); blit(bloom[i - 1].fb, bloom[i - 1].w, bloom[i - 1].h); }
    gl.disable(gl.BLEND);

    // composite
    const aberr = 0.0012 + A.desync * 0.0035 * ss(0.3, 0.4, st.p) + Math.min(0.012, Math.abs(st.vel) * 0.03);
    P.comp.use().tex('uScene', scene.t).tex('uBloom', bloom[0].t).tex('uFluid', black).tex('uStreakSrc', bloom[Math.min(2, bloom.length - 1)].t).f('uStreak', tier === 'low' ? 0 : 0.07).f('uRes', W, H).f('uTime', st.time)
      .f('uAberr', reduced ? 0.002 : aberr).f('uBloomK', 0.9).f('uGrain', 0.03 * (1 - 0.6 * A.mark)).f('uFade', reduced ? 1 : Math.min(1, st.time * 0.6)).f('uFluidK', 0).f('uFlash', st.flash);
    blit(null, W, H);

    drawHud(A, u);
    drawWords(A);
  }
  // sound
  const offs = wall.peers.map((ti) => D[ti * STRIDE + 14] * Math.min(1, Math.max(0, A.desync * 1.25 - D[ti * STRIDE + 13] * 0.25)));
  const present = A.arrive.map((v, k) => (k === 0 ? ss(0.07, 0.1, st.p) : v));
  const filled = wall.peers.map((_, k) => (k === 0 ? 1 : Math.min(1, Math.max(0, (A.fill - peerFillT[k]) / 0.07))));
  safe(() => sound.update({ offsets: offs, present, filled, together: 1 - A.desync, hold: st.hold, p: st.p, intro: st.intro, mark: A.mark, dt }));
  if (!NODRAW) drawWave(A);
  // the rail's slider value
  const pct = Math.round(st.p * 100);
  if (pct !== railShown) { railShown = pct; const act = ACTS.filter((a) => st.p >= a[2] - 0.001).pop(); rail.setAttribute('aria-valuenow', String(pct)); rail.setAttribute('aria-valuetext', `${act[1]}, ${pct} per cent`); }

  // keep it smooth: lower the resolution when frames run long, raise it again when there is room
  ema = ema * 0.95 + dt * 1000 * 0.05; frames++; stats.frames++; if (dt > 1 / 45) stats.slow++;
  stats.js = (stats.js || 0) * 0.95 + (performance.now() - t0) * 0.05; // main-thread time per frame (ms), GPU work not included
  if (now - lastAdapt > 2000 && frames > 60 && !reduced && !CAP) {
    fpsLog.push(Math.round(1000 / ema)); if (fpsLog.length > 300) fpsLog.shift();
    if (ema > 21 && scale > 0.5) { scale = Math.max(0.5, scale * 0.85); build(); }
    else if (ema < 13 && scale < TIER.scale) { scale = Math.min(TIER.scale, scale * 1.1); build(); }
    lastAdapt = now; frames = 0;
  }
}

addEventListener('resize', () => { build(); if (reduced) requestAnimationFrame(frame); });
// the replay side of a recording: render the logged sound calls offline, frame by frame
async function renderAudio(n) {
  const sc = await loadScore(SCORE);
  const sr = sc.man.sampleRate, oc = new OfflineAudioContext(2, Math.ceil(sr * (n / 30 + 2)), sr);
  const S2 = new Sound(SCORE); const byFrame = new Map(); for (const e of soundLog) (byFrame.get(e[0]) || byFrame.set(e[0], []).get(e[0])).push(e);
  let started = false;
  for (let i = 0; i < n; i++) oc.suspend(i / 30).then(() => { for (const [, k, a] of byFrame.get(i) || []) { if (k === 'start') { if (!started) { S2.start(oc); started = true; } } else if (started) S2[k](...a); } oc.resume(); });
  const buf = await oc.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1), len = L.length; const ab = new ArrayBuffer(44 + len * 4); const v = new DataView(ab);
  const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, len * 4, true);
  for (let i = 0; i < len; i++) { v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true); v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true); }
  const bytes = new Uint8Array(ab); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
Object.assign(window.__art, {
  capLog, soundLog, renderAudio,
  playFrame(f) {
    Object.assign(st, { target: f.target, holding: f.holding, mx: f.mx, my: f.my, started: f.started, idle: f.idle });
    if (f.ask && st.identAsked < 0) st.identAsked = st.time; // the press that starts the opening
    root.classList.toggle('pointer', f.pointer);
    for (const [x, y] of f.pings) ping(x, y);
    if (f.started) { root.classList.add('started'); soundBtn.hidden = false; }
    if (f.audio && !sound.on) { sound.start(); soundBtn.setAttribute('aria-pressed', 'true'); soundBtn.querySelector('.say').textContent = 'Sound on'; }
    frame(st.last + 1000 / 30);
  },
});
const go = () => { root.classList.add('live'); st.last = performance.now(); if (CAP !== 'play' && !MANUAL) requestAnimationFrame(frame); else window.__art.ready = true; };
window.__art.step = (n = 1) => { for (let i = 0; i < n; i++) frame(st.last + 1000 / 30); };
// fonts for the canvas text first; never wait long for them
Promise.race([Promise.all(['400 12px "Tandem Mono"', '700 12px "Tandem Mono"'].map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 1200))]).then(go, go);
