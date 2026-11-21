// The wall: every screen in the piece as one rectangle. The middle is Tandem's mark (the Wall, from img/icon.svg:
// dim screens, the lit T, the cyan playhead and the pink late dot); around it a field of screens cut the same way
// (guillotine cuts on a 3-unit grid with 3-unit gutters). Each rectangle is then split again into smaller screens,
// the mosaic, which merges back into the mark at the end. World units are the mark's 96-unit box, centred, y up.

export const HANDLES = ['neonquokka', 'velvetkoi', 'tofu.rocket', 'fizzwhale', 'mintylynx', 'cosmic.crumpet', 'moonmilk.07', 'orbitbeans'];
// Floats per screen in the data texture: five RGBA texels.
export const STRIDE = 20;

// The mark's primary tier, as boxes [x, y, w, h] in the 96 box (y down) with a role and which corners are cut
// (tr: top right, bl: bottom left), read from img/icon.svg.
const DIM = [[0, 0, 21, 12], [24, 0, 33, 12], [60, 0, 36, 12], [0, 15, 12, 27], [0, 45, 12, 51], [81, 15, 15, 36], [81, 54, 15, 42], [15, 30, 21, 15],
  [15, 48, 9, 33], [27, 48, 9, 18], [27, 69, 9, 12], [57, 30, 21, 21], [57, 54, 21, 12], [57, 69, 6, 12], [15, 84, 27, 12], [45, 84, 12, 12], [60, 84, 18, 12]];
const LIT = [[15, 15, 18, 12, 1, 1], [36, 15, 8, 12, 0, 1], [49, 15, 14, 12, 1, 0], [66, 15, 12, 12, 1, 1], [39, 30, 5, 27, 0, 1], [49, 30, 5, 27, 1, 0], [39, 60, 5, 21, 0, 1], [49, 60, 5, 21, 1, 0]];
const PLAY = [[45, 15, 3, 12], [45, 30, 3, 27], [45, 60, 3, 21], [67.86, 69, 3, 12]];
const DOT = [[66, 69, 0.86, 12, 0, 1], [71.86, 69, 6.14, 12, 1, 0]];
export const ROLE = { field: 0, dim: 1, lit: 2, play: 3, dot: 4 };
// Which mark piece each named person sits in (index into LIT or DIM), so they end up inside the mark.
const SEATS = [['lit', 0], ['lit', 2], ['lit', 3], ['lit', 4], ['lit', 7], ['dim', 11], ['dim', 4], ['dim', 14]];

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Guillotine partition of [x0,y0,x1,y1]: cuts on `grid`, `gap` wide, until a piece is small enough (with chance).
function partition(r, rand, o, out, depth = 0) {
  const [x0, y0, x1, y1] = r; const w = x1 - x0, h = y1 - y0;
  const area = w * h;
  const stop = depth >= o.minDepth && (area < o.maxArea * (0.35 + rand() * 0.9) || depth > 14);
  const canX = w >= 2 * o.min + o.gap, canY = h >= 2 * o.min + o.gap;
  if (stop || (!canX && !canY)) { out.push(r); return; }
  let vertical = w / h > 1.25 ? true : h / w > 1.25 ? false : rand() < 0.5; // vertical: cut across x
  if (vertical && !canX) vertical = false; if (!vertical && !canY) vertical = true;
  const len = vertical ? w : h; const lo = o.min, hi = len - o.min - o.gap;
  let c = lo + (hi - lo) * (0.2 + rand() * 0.6); c = Math.round(c / o.grid) * o.grid; c = Math.max(lo, Math.min(hi, c));
  if (vertical) { partition([x0, y0, x0 + c, y1], rand, o, out, depth + 1); partition([x0 + c + o.gap, y0, x1, y1], rand, o, out, depth + 1); }
  else { partition([x0, y0, x1, y0 + c], rand, o, out, depth + 1); partition([x0, y0 + c + o.gap, x1, y1], rand, o, out, depth + 1); }
}

/** Build the wall for about `target` screens. Returns { tiles, links, host, nextHost, peers, extent }. */
export function buildWall(target = 1200, seed = 7) {
  const rand = rng(seed);
  const parents = [];
  const add = (b, role, tr = 1, bl = 1) => parents.push({ x: b[0], y: b[1], w: b[2], h: b[3], role, tr, bl });
  DIM.forEach((b) => add(b, ROLE.dim)); LIT.forEach((b) => add(b, ROLE.lit, b[4], b[5]));
  PLAY.forEach((b, i) => add(b, ROLE.play, 0, i === 3 ? 1 : 0)); DOT.forEach((b) => add(b, ROLE.dot, b[4], b[5]));
  // The field around the mark, wider than any screen shape will show.
  const F = [[-120, -66, 216, -3], [-120, 99, 216, 162], [-120, 0, -3, 96], [99, 0, 216, 96]];
  const field = [];
  for (const r of F) partition(r, rand, { grid: 3, gap: 3, min: 6, maxArea: 520, minDepth: 2 }, field);
  for (const [x0, y0, x1, y1] of field) add([x0, y0, x1 - x0, y1 - y0], ROLE.field);
  // Split every parent into mosaic children until there are about `target` screens.
  const totalArea = parents.reduce((s, p) => s + p.w * p.h, 0);
  const perChild = totalArea / target;
  const tiles = [];
  const seatParents = SEATS.map(([kind, i]) => (kind === 'lit' ? DIM.length + i : i));
  parents.forEach((p, pi) => {
    const kids = [];
    const thin = Math.min(p.w, p.h) < 4;
    const forced = seatParents.includes(pi) ? 1 : 0; // a named person's piece always splits, so the host's hole fills later
    // the field keeps bigger screens (a TV, a laptop, a phone), the mark is cut finer
    const per = p.role === ROLE.field ? perChild * 3.2 : perChild * 0.55;
    if (thin || p.w * p.h < per * 1.4) { if (forced && !thin) partition([p.x, p.y, p.x + p.w, p.y + p.h], rand, { grid: 0.5, gap: 1, min: 1.5, maxArea: p.w * p.h * 0.45, minDepth: 1 }, kids); else kids.push([p.x, p.y, p.x + p.w, p.y + p.h]); }
    else partition([p.x, p.y, p.x + p.w, p.y + p.h], rand, { grid: 0.5, gap: 1, min: 2, maxArea: per * 1.6, minDepth: forced }, kids);
    for (const [x0, y0, x1, y1] of kids) tiles.push({ parent: pi, p, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  });
  // World coordinates: the mark's centre at the origin, y up.
  const W = (x, y) => [x - 48, 48 - y];
  const peers = [];
  SEATS.forEach(([kind, i], k) => {
    const pi = seatParents[k];
    // the biggest child of that piece
    let best = -1, area = -1; tiles.forEach((t, ti) => { if (t.parent === pi && t.w * t.h > area) { area = t.w * t.h; best = ti; } });
    peers.push(best);
  });
  const host = peers[0], nextHost = peers[1];
  const [hx, hy] = (() => { const t = tiles[host]; return W(t.x + t.w / 2, t.y + t.h / 2); })();
  // Per tile: 5 RGBA float texels. 0: child rect (cx, cy, w, h); 1: parent rect; 2: scattered position and seed;
  // 3: role, delay, offset (s), flags (3 + k for named person k: 3 is the host, 4 the next host; 0 for everyone else),
  // with the corner cuts packed into its fraction; 4: when the invite reaches it, when the film reaches it (0..1).
  const data = new Float32Array(tiles.length * STRIDE);
  tiles.forEach((t, i) => {
    const [cx, cy] = W(t.x + t.w / 2, t.y + t.h / 2); const [px, py] = W(t.p.x + t.p.w / 2, t.p.y + t.p.h / 2);
    // scattered in a deep volume around the camera's path, kept out of a narrow corridor so the flight is clear
    // a loose cloud, denser toward the middle, with no hard edge
    let sx, sy; do { const r = Math.pow(rand(), 0.75) * 300, a = rand() * Math.PI * 2; sx = Math.cos(a) * r * 1.15; sy = Math.sin(a) * r * 0.62; } while (Math.abs(sx) < 14 && Math.abs(sy) < 10);
    const sz = -260 + Math.pow(rand(), 0.8) * 1150;
    const seed = rand();
    const d = Math.hypot(cx - hx, cy - hy);
    const delay = Math.min(1, d / 190) * 0.75 + rand() * 0.25;
    const off = (rand() * 2 - 1) * (1.2 + rand() * 2.2);
    let flags = 0; const k = peers.indexOf(i);
    if (k >= 0) flags = 3 + k;
    // the named people get calm places in the cloud: the host in front, the others around, where their names read
    if (k === 0) { sx = 0; sy = 0; } else if (k > 0) { const a = (k / 7) * Math.PI * 2 + 0.4, r = 92 + 26 * (k % 3); sx = Math.cos(a) * r * 1.3; sy = Math.sin(a) * r * 0.62; }
    const szz = k === 0 ? 260 : k > 0 ? 120 + 70 * (k % 4) : sz;
    const o = i * STRIDE;
    data.set([cx, cy, t.w, t.h, px, py, t.p.w, t.p.h, sx, sy, szz, seed, t.p.role, delay, off, flags], o);
    // which corners are cut: 1 top right, 2 bottom left, 3 both (packed into the flags below)
    t.cut = (t.p.tr ? 1 : 0) + (t.p.bl ? 2 : 0);
  });
  // Named people: a calmer, readable offset each.
  const named = [0.0, 0.41, -1.37, 2.12, -0.86, 1.64, -2.31, 0.97];
  peers.forEach((ti, k) => { data[ti * STRIDE + 14] = named[k]; data[ti * STRIDE + 13] = k === 0 ? 0 : data[ti * STRIDE + 13]; });
  tiles.forEach((t, i) => { data[i * STRIDE + 15] += t.cut * 0.1; });
  const N0 = tiles.length;
  const sp = (i) => [data[i * STRIDE + 8], data[i * STRIDE + 9], data[i * STRIDE + 10]];
  const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  // The invite: from the host it hops screen to screen through the cloud, a spiral outward, nine hops.
  const hops = [host]; let cur = sp(host), ang = 0.3;
  for (let h = 0; h < 9; h++) {
    ang += 1.1; let best = -1, bs = 1e9;
    const want = [cur[0] + Math.cos(ang) * 75, cur[1] + Math.sin(ang) * 45, 160 + h * 12];
    for (let i = 0; i < N0; i++) { if (peers.includes(i) || hops.includes(i)) continue; const d = dist3(sp(i), want); if (d < bs) { bs = d; best = i; } }
    hops.push(best); cur = sp(best);
  }
  const H = hops.length;
  const hostP = sp(host); let far = 1;
  for (let i = 0; i < N0; i++) far = Math.max(far, dist3(sp(i), hostP));
  // a screen joins from the hop that reaches it first: hops cost one step each, distance costs a step per 60 units
  const jraw = new Float32Array(N0); let jmax = 1;
  for (let i = 0; i < N0; i++) { const q = sp(i); let j = 1e9; hops.forEach((hi, h) => { j = Math.min(j, h + dist3(q, sp(hi)) / 60); }); jraw[i] = j; jmax = Math.max(jmax, j); }
  for (let i = 0; i < N0; i++) {
    // the room's screens join in a ripple out from the host's screen as the invite passes through on its way out
    const q = sp(i); let jt = Math.min(1, dist3(q, hostP) / far) * 0.85 + rand() * 0.08;
    let ft = Math.min(1, dist3(q, hostP) / far) * 0.82 + rand() * 0.15;
    const k = peers.indexOf(i);
    if (k === 0) { jt = 0; ft = 0; } else if (k > 0) ft = 0.12 + k * 0.1;
    data[i * STRIDE + 16] = jt; data[i * STRIDE + 17] = ft;
  }
  hops.forEach((hi, h) => { data[hi * STRIDE + 16] = h / jmax; });
  // Links: each screen to its two nearest neighbours on the wall and one farther one; a mesh with no middle.
  const cx = (i) => data[i * STRIDE], cy = (i) => data[i * STRIDE + 1];
  const N = tiles.length; const links = []; const seen = new Set();
  const cell = 16; const grid = new Map();
  for (let i = 0; i < N; i++) { const key = `${Math.floor(cx(i) / cell)},${Math.floor(cy(i) / cell)}`; (grid.get(key) || grid.set(key, []).get(key)).push(i); }
  const link = (a, b) => { const k = a < b ? `${a}-${b}` : `${b}-${a}`; if (a === b || seen.has(k)) return; seen.add(k); links.push(a, b, rand()); };
  for (let i = 0; i < N; i++) {
    const gx = Math.floor(cx(i) / cell), gy = Math.floor(cy(i) / cell); const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(`${gx + dx},${gy + dy}`) || []) if (j !== i) near.push([Math.hypot(cx(i) - cx(j), cy(i) - cy(j)), j]);
    near.sort((a, b) => a[0] - b[0]);
    near.slice(0, 2).forEach(([, j]) => link(i, j));
    if (rand() < 0.35) link(i, Math.floor(rand() * N));
  }
  peers.forEach((a, k) => peers.forEach((b, m) => { if (m > k) link(a, b); })); // the named people are all linked to each other
  return { data, count: N, links: new Float32Array(links), linkCount: links.length / 3, host, nextHost, peers, hops, hopT: hops.map((_, h) => h / jmax) };
}

// Where each friend flies in from, in the arrivals: a direction per person (x, y, z), matched in the tile shader.
export const ARRIVE_DIR = [[0, 0, 0], [1, 0.25, -0.3], [-1, 0.55, -0.2], [0.2, -1, -0.4], [-0.8, -0.7, 0.1], [0.9, 0.9, -0.5], [-1, -0.1, 0.4], [0.3, 1, 0.2]];

// The same placement maths as the tile shader's, on the CPU, for the labels (no fluid, no wave).
export function tileCentre(data, i, u, out) {
  const o = i * STRIDE; const role = data[o + 12]; const flags = Math.floor(data[o + 15]); const seed = data[o + 11];
  const m = role > 0.5 ? u.merge : 0;
  const rx = data[o] + (data[o + 4] - data[o]) * m, ry = data[o + 1] + (data[o + 5] - data[o + 1]) * m;
  let a = Math.min(1, Math.max(0, u.assemble * 1.8 - data[o + 13] * 0.8)); a = a * a * (3 - 2 * a);
  const s = 1 - a, k = a * s * 60;
  out[0] = data[o + 8] + (rx - data[o + 8]) * a + Math.sin(seed * 12.1 + u.time * 0.3) * k + Math.sin(u.time * 0.12 + seed * 40) * s * 3;
  out[1] = data[o + 9] + (ry - data[o + 9]) * a + Math.cos(seed * 7.3 + u.time * 0.27) * k + Math.cos(u.time * 0.1 + seed * 31) * s * 3;
  out[2] = data[o + 10] * s + Math.sin(seed * 3.1 + u.time * 0.2) * k;
  if (flags === 3) { const g = u.hostGone; out[2] += g * g * 420; out[1] += g * g * 30; }
  if (flags > 3 && u.arrive) { const k = flags - 3, r = 1 - u.arrive[k]; const d = ARRIVE_DIR[k]; out[0] += d[0] * r * r * 520; out[1] += d[1] * r * r * 520; out[2] += d[2] * r * r * 300; }
  return a;
}
