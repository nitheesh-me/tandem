// The arena behind the hero: one full-screen fragment shader, no library.
// Spotlight beams sweep through haze and rain from the truss, a follow spot
// chases the pointer, laser fans fire from the wings, and a sea of phone lights
// twinkles over the crowd. The page feeds it the anthem's levels when the sound
// is on. It draws at a reduced, adaptive resolution capped at 1.5x the device
// pixel ratio, and stops whenever it is off-screen or the tab is hidden.

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uIntro, uBass, uKick, uDrop, uBar, uBlack, uHigh;
uniform vec2 uPtr;

const vec3 CYAN = vec3(0.0, 0.94, 1.0);
const vec3 PINK = vec3(1.0, 0.165, 0.427);
const vec3 YELLOW = vec3(0.976, 0.94, 0.008);
const vec3 GREEN = vec3(0.02, 1.0, 0.63);
const vec3 VIOLET = vec3(0.706, 0.3, 1.0);
const vec3 BG = vec3(0.027, 0.016, 0.059);

float hash(vec2 q) { q = fract(q * vec2(123.34, 456.21)); q += dot(q, q + 45.32); return fract(q.x * q.y); }
float noise(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
}
vec3 tint(float k) {
  k = mod(k, 5.0);
  return k < 1.0 ? CYAN : k < 2.0 ? PINK : k < 3.0 ? VIOLET : k < 4.0 ? GREEN : YELLOW;
}

// A cone of light from o along dir: soft edges, brightest near the source.
float beam(vec2 p, vec2 o, vec2 dir, float spread) {
  vec2 d = p - o;
  float along = dot(d, dir);
  if (along < 0.0) return 0.0;
  float across = abs(dot(d, vec2(-dir.y, dir.x)));
  float w = 0.012 + along * spread;
  return exp(-(across * across) / (w * w)) * exp(-along * 0.55) * smoothstep(0.0, 0.05, along);
}

// A laser: a hard core and a short glow, fading with distance.
float laser(vec2 p, vec2 o, float a) {
  vec2 dir = vec2(sin(a), cos(a));
  vec2 d = p - o;
  float along = dot(d, dir);
  if (along < 0.0) return 0.0;
  float across = abs(dot(d, vec2(-dir.y, dir.x)));
  return (exp(-across * 900.0) + exp(-across * 90.0) * 0.18) * exp(-along * 0.9);
}

// One layer of phone lights: a jittered grid, each cell maybe holding a phone.
vec3 phones(vec2 p, float cell, float r, float density, float top, float bottom, float t) {
  float band = smoothstep(bottom, bottom + 0.03, p.y) * smoothstep(top, top - 0.02, p.y);
  if (band <= 0.0) return vec3(0.0);
  vec2 q = p / cell;
  vec2 id = floor(q);
  float h = hash(id);
  if (h > density) return vec3(0.0);
  float h2 = hash(id + 7.1);
  // Phones sway in slow waves across the crowd, and jump a little on the kick.
  vec2 jitter = vec2(h2 - 0.5, hash(id + 3.3) - 0.5) * 0.5;
  float energy = clamp(uBass * 1.4, 0.0, 1.0) * (1.0 - uBlack);
  // Idle: a slow drift. With the music: the whole crowd sways with the bar, in a wave.
  float sway = sin(uBar * 6.2832 * 0.5 + id.x * 0.12 + h2 * 0.6);
  jitter.x += mix(sin(t * 1.3 + id.x * 0.25 + id.y) * 0.18, sway * 0.38, energy);
  jitter.y += uKick * 0.16 * (0.5 + h2) + uDrop * 0.35 * (0.6 + 0.4 * h2);
  float d = length(fract(q) - 0.5 - jitter);
  float twinkle = 0.55 + 0.45 * sin(t * (1.5 + h2 * 3.0) + h * 40.0);
  twinkle *= 1.0 + uKick * 0.9 * energy + uDrop * 0.8;
  float core = smoothstep(r, r * 0.3, d);
  float glow = exp(-d * 9.0) * 0.35;
  vec3 c = mix(vec3(1.0, 0.95, 0.85), h2 > 0.82 ? PINK : h2 > 0.64 ? CYAN : vec3(1.0, 0.95, 0.85), 0.75);
  return c * (core + glow) * twinkle * band;
}

// A row of heads and raised arms, as a dark silhouette line.
float crowdLine(vec2 p, float base, float scale, float seed) {
  float x = p.x * scale + seed;
  float id = floor(x);
  float fx = fract(x) - 0.5;
  float h = hash(vec2(id, seed));
  float energy = clamp(uBass * 1.4, 0.0, 1.0) * (1.0 - uBlack);
  // Each person bounces on the beat (four to a bar), a little early or late, more with the bass.
  float beat = fract(uBar * 4.0 + (h - 0.5) * 0.18);
  float bounce = pow(1.0 - beat, 3.0) * energy * (0.5 + 0.5 * h);
  float jump = uDrop * (0.7 + 0.3 * h);
  float lift = (bounce * 0.9 + jump * 2.2) / scale;
  // Arms: a few up when quiet, most up when it is loud, all up on the big hits.
  float armsUp = 0.7 - energy * 0.35 - uDrop * 0.6;
  float armSide = h > 0.85 ? -0.25 : 0.25;
  // A raised arm: a short thick forearm with a hand on top, pumping a little on the kick.
  float reach = 0.55 + uKick * 0.2 * energy + uDrop * 0.15;
  float ax = abs(fx - armSide);
  float arm = h > armsUp ? (smoothstep(0.075, 0.035, ax) * reach + smoothstep(0.09, 0.05, ax) * 0.12) / scale : 0.0;
  float head = sqrt(max(0.0, 0.16 - fx * fx)) * (0.6 + 0.4 * h) / scale;
  float line = base + lift + head * 1.3 + arm * 1.6 + noise(vec2(p.x * 40.0, seed)) * 0.004;
  return smoothstep(line + 0.002, line - 0.002, p.y);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float aspect = uRes.x / uRes.y;
  float t = uTime;
  float lit = uIntro * (1.0 - uBlack * 0.85);
  float horizon = -0.12;
  // Phones in portrait get tighter, dimmer beams so the haze does not wash the screen.
  float narrow = clamp(aspect, 0.45, 1.0);
  float dim = mix(0.42, 1.0, smoothstep(0.55, 1.1, aspect));

  // Haze drifting through the hall, which the beams light up.
  float haze = noise(p * 3.0 + vec2(t * 0.05, -t * 0.02)) * 0.6 + noise(p * 7.0 - vec2(t * 0.08, 0.0)) * 0.4;
  // Rain, only visible where light catches it.
  float rx = p.x * 110.0 + p.y * 14.0;
  float col = floor(rx);
  float rain = step(0.78, hash(vec2(col, 2.0))) * smoothstep(0.12, 0.0, abs(fract(rx) - 0.5))
    * smoothstep(0.85, 1.0, fract(p.y * 1.6 + t * (1.4 + hash(vec2(col, 5.0))) + hash(vec2(col, 9.0)) * 9.0));

  vec3 c = BG;
  // The back wall: a faint grid of LED panels behind the stage.
  vec2 g = abs(fract(p * vec2(16.0, 16.0)) - 0.5);
  float grid = smoothstep(0.47, 0.5, max(g.x, g.y)) * smoothstep(horizon, horizon + 0.5, p.y) * 0.05;
  c += VIOLET * grid * (0.4 + lit);

  // The LED wall's spill behind the title.
  float wall = exp(-pow(p.y - 0.12, 2.0) * 18.0) * exp(-p.x * p.x * 1.4);
  c += mix(VIOLET, CYAN, 0.5 + 0.5 * sin(t * 0.3)) * wall * (0.1 + 0.18 * lit + 0.25 * uKick * lit) * dim;

  // Spotlights from the truss, sweeping, one of them chasing the pointer.
  vec3 light = vec3(0.0);
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float on = smoothstep(fi / 6.0, fi / 6.0 + 0.2, uIntro);
    // On a portrait screen, four beams from beyond the edges cross instead of six piling up.
    if (aspect < 0.8 && (i == 1 || i == 4)) continue;
    vec2 o = vec2((fi / 5.0 - 0.5) * max(aspect, 0.8) * 0.95, 0.62);
    float sweep = sin(t * (0.25 + fi * 0.04) + fi * 1.7 + uBar * 0.9) * 0.55;
    vec2 aim = normalize(vec2(sweep - o.x * 0.25, -1.0));
    if (i == 2) aim = normalize(uPtr - o);
    float b = beam(p, o, aim, (i == 2 ? 0.07 : 0.1) * narrow * narrow * narrow + 0.008) * dim;
    light += tint(fi + floor(uBar * 0.25)) * b * on;
  }
  float hazeLit = (0.45 + 0.75 * haze) * mix(0.75, 1.0, dim);
  c += light * hazeLit * lit * (0.55 + 0.35 * uBass + 0.6 * uDrop) + light * rain * 0.9 * lit;

  // Laser fans from both wings: quiet without the music, alive with it.
  float fan = 0.0;
  float spin = sin(t * 0.6) * 0.35 + uBar * 0.5;
  for (int k = 0; k < 7; k++) {
    float fk = float(k) / 6.0 - 0.5;
    fan += laser(p, vec2(-max(aspect, 0.9) * 0.46, horizon + 0.02), 0.55 + fk * 0.9 + spin * 0.4);
    fan += laser(p, vec2(max(aspect, 0.9) * 0.46, horizon + 0.02), -0.55 + fk * 0.9 - spin * 0.4);
  }
  float laserAmt = dim * dim * lit * (0.12 + 0.55 * uKick + 0.9 * uDrop + 0.15 * uHigh);
  c += mix(GREEN, tint(floor(uBar) + 1.0), 0.5) * fan * laserAmt;

  // The stage edge: a bright strip along the horizon.
  float edge = exp(-abs(p.y - horizon) * 260.0) * smoothstep(aspect * 0.5, aspect * 0.2, abs(p.x));
  c += mix(CYAN, PINK, smoothstep(-0.4, 0.4, p.x)) * edge * (0.25 + 0.75 * lit);
  c += VIOLET * exp(-abs(p.y - horizon) * 14.0) * 0.12 * lit;

  // The crowd, far to near: phone lights, then heads in front of them.
  if (p.y < horizon) {
    c *= 0.6;
    c += phones(p, 0.011, 0.22, 0.55, horizon - 0.005, horizon - 0.12, t) * 0.55;
    c += phones(p, 0.022, 0.2, 0.4, horizon - 0.07, horizon - 0.26, t + 3.0) * 0.8;
    float row1 = crowdLine(p, horizon - 0.2, 26.0, 1.0);
    c = mix(c, BG * 0.4 + light * 0.05, row1 * 0.85);
    c += phones(p, 0.05, 0.16, 0.3, horizon - 0.2, -0.6, t + 7.0) * row1;
    float row2 = crowdLine(p, horizon - 0.33, 14.0, 4.0);
    c = mix(c, BG * 0.2, row2 * 0.92);
  }

  // Lift everything on the big hits, then a soft tone curve, vignette and grain.
  c += vec3(0.9, 0.85, 1.0) * uDrop * 0.12 * lit;
  c = 1.0 - exp(-c * 1.35);
  c *= 1.0 - 0.55 * dot(p / vec2(aspect * 0.6, 0.62), p / vec2(aspect * 0.6, 0.62)) * 0.5;
  c += (hash(gl_FragCoord.xy + fract(t) * 100.0) - 0.5) * 0.025;
  gl_FragColor = vec4(max(c, 0.0), 1.0);
}`;

/**
 * Starts the arena on a canvas. Returns null when WebGL is not available, so the
 * page keeps its still fallback.
 */
export function startArena(canvas, { still = false } = {}) {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
  if (!gl) return null;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const prog = gl.createProgram();
  try {
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  } catch { return null; }
  gl.bindAttribLocation(prog, 0, 'p');
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const u = {};
  for (const name of ['uRes', 'uTime', 'uIntro', 'uBass', 'uKick', 'uDrop', 'uBar', 'uBlack', 'uHigh', 'uPtr']) u[name] = gl.getUniformLocation(prog, name);

  const small = matchMedia('(max-width: 700px)').matches;
  const DPR = Math.min(devicePixelRatio || 1, 1.5);
  // Quality is the share of the capped pixel ratio actually drawn; it adapts to frame times.
  let quality = small ? 0.55 : 0.7;
  const MIN_Q = 0.45, MAX_Q = small ? 0.7 : 0.85;
  const state = { intro: still ? 1 : 0, bass: 0, kick: 0, drop: 0, bar: 0, black: 0, high: 0 };
  const ptr = { x: 0, y: -0.1, gx: 0, gy: -0.1 };
  let running = false, raf = 0, last = 0, w = 0, h = 0, t0 = performance.now(), slow = 0, quick = 0;
  const stats = { frames: 0, sum: 0, worst: 0, quality };

  function size() {
    const r = canvas.getBoundingClientRect();
    const nw = Math.max(1, Math.round(r.width * DPR * quality));
    const nh = Math.max(1, Math.round(r.height * DPR * quality));
    if (nw === w && nh === h) return;
    w = canvas.width = nw;
    h = canvas.height = nh;
    gl.viewport(0, 0, w, h);
  }

  function draw(now) {
    const t = still ? 12.0 : (now - t0) / 1000;
    ptr.x += (ptr.gx - ptr.x) * 0.06;
    ptr.y += (ptr.gy - ptr.y) * 0.06;
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, t);
    gl.uniform1f(u.uIntro, state.intro);
    gl.uniform1f(u.uBass, state.bass);
    gl.uniform1f(u.uKick, state.kick);
    gl.uniform1f(u.uDrop, state.drop);
    gl.uniform1f(u.uBar, state.bar);
    gl.uniform1f(u.uBlack, state.black);
    gl.uniform1f(u.uHigh, state.high);
    gl.uniform2f(u.uPtr, ptr.x, ptr.y);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = last ? now - last : 16;
    last = now;
    // Without music, the bar counter still turns slowly so the lights keep changing.
    if (!state.music) state.bar += dt / 1000 / 5.2;
    stats.frames++; stats.sum += dt; stats.worst = Math.max(stats.worst, dt);
    // Adapt the resolution: drop it quickly when frames run long, raise it slowly.
    if (dt > 24) { slow++; quick = 0; } else if (dt < 15) { quick++; slow = 0; }
    if (slow > 8 && quality > MIN_Q) { quality = Math.max(MIN_Q, quality * 0.82); slow = 0; size(); }
    if (quick > 180 && quality < MAX_Q) { quality = Math.min(MAX_Q, quality * 1.08); quick = 0; size(); }
    stats.quality = quality;
    draw(now);
  }

  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    ptr.gx = (e.clientX - r.left - r.width / 2) / r.height;
    ptr.gy = -(e.clientY - r.top - r.height / 2) / r.height;
  };
  const ro = new ResizeObserver(() => { size(); if (!running) draw(performance.now()); });
  ro.observe(canvas);
  size();
  if (still) {
    draw(performance.now());
  } else {
    addEventListener('pointermove', onMove, { passive: true });
  }

  return {
    stats,
    /** Levels from the music, all 0 to 1. */
    set(values) { Object.assign(state, values); },
    play(on) {
      if (still || on === running) return;
      running = on;
      last = 0;
      if (on) raf = requestAnimationFrame(frame);
      else cancelAnimationFrame(raf);
    },
    get running() { return running; },
  };
}
