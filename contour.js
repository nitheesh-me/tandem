// The contour map, grown fresh in the browser. Layered noise makes the terrain
// and marching squares draws its height lines. It drifts by itself, rises toward
// the pointer or a finger, and ripples where pressed. window.contour.pause() stops
// it, so it never competes with the trailer.
(() => {
  const canvas = document.getElementById('contour');
  const paint = canvas.getContext('2d', { alpha: false });
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const CELL = 18, LEVELS = 9, FRAME_MS = 1000 / 30, DRIFT = 0.00006, SCALE = 0.0021;
  const LINE = '#2C1B4D', BG = '#07040F', REACH = 190, RISE = 0.22, RIPPLE_MS = 1900, RIPPLE_SPEED = 0.36;

  const lattice = new Float32Array(4096).map((_, i) => {
    const s = Math.sin(i * 12.9898) * 43758.5453;
    return s - Math.floor(s);
  });
  const at = (x, y, z) => lattice[(x * 73 + y * 179 + z * 283) & 4095];
  const ease = (t) => t * t * (3 - 2 * t);
  const mix = (a, b, t) => a + (b - a) * t;
  function noise(x, y, z) {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z);
    const u = ease(x - i), v = ease(y - j), w = ease(z - k);
    const plane = (l) => mix(mix(at(i, j, l), at(i + 1, j, l), u), mix(at(i, j + 1, l), at(i + 1, j + 1, l), u), v);
    return mix(plane(k), plane(k + 1), w);
  }

  let cols = 0, rows = 0, field = new Float32Array(0), width = 0, tall = 0;
  const hand = { x: -999, y: -999, goalX: -999, goalY: -999, power: 0, moved: -1e9 };
  let ripples = [], paused = false, frame = 0, last = 0;

  function size() {
    const scale = Math.min(devicePixelRatio, 1.5);
    width = innerWidth; tall = innerHeight;
    canvas.width = width * scale;
    canvas.height = tall * scale;
    paint.setTransform(scale, 0, 0, scale, 0, 0);
    cols = Math.ceil(width / CELL) + 2;
    rows = Math.ceil(tall / CELL) + 2;
    field = new Float32Array(cols * rows);
    if (calm.matches) draw(9000, true);
  }

  function height(x, y, t) {
    const z = t * DRIFT;
    const warp = noise(x * SCALE * 0.6 + 40, y * SCALE * 0.6, z) * 1.6;
    let h = noise(x * SCALE + warp, y * SCALE - warp, z) * 0.72 + noise(x * SCALE * 2.3, y * SCALE * 2.3, z * 1.4) * 0.28;
    const dx = x - hand.x, dy = y - hand.y;
    h += hand.power * RISE * Math.exp(-(dx * dx + dy * dy) / (REACH * REACH));
    for (const r of ripples) {
      const age = t - r.born;
      const off = Math.hypot(x - r.x, y - r.y) - age * RIPPLE_SPEED;
      h += 0.1 * (1 - age / RIPPLE_MS) * Math.exp(-(off * off) / 2600);
    }
    return h;
  }

  function trace(level) {
    const seg = (a, b, c, d) => { paint.moveTo(a, b); paint.lineTo(c, d); };
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const o = r * cols + c;
        const a = field[o], b = field[o + 1], d = field[o + cols + 1], e = field[o + cols];
        const shape = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (d > level ? 2 : 0) | (e > level ? 1 : 0);
        if (shape === 0 || shape === 15) continue;
        const x = c * CELL, y = r * CELL;
        const tx = x + (CELL * (level - a)) / (b - a), ry = y + (CELL * (level - b)) / (d - b);
        const bx = x + (CELL * (level - e)) / (d - e), ly = y + (CELL * (level - a)) / (e - a);
        switch (shape) {
          case 1: case 14: seg(x, ly, bx, y + CELL); break;
          case 2: case 13: seg(bx, y + CELL, x + CELL, ry); break;
          case 3: case 12: seg(x, ly, x + CELL, ry); break;
          case 4: case 11: seg(tx, y, x + CELL, ry); break;
          case 6: case 9: seg(tx, y, bx, y + CELL); break;
          case 7: case 8: seg(x, ly, tx, y); break;
          case 5: seg(x, ly, tx, y); seg(bx, y + CELL, x + CELL, ry); break;
          case 10: seg(x, ly, bx, y + CELL); seg(tx, y, x + CELL, ry); break;
        }
      }
    }
  }

  function draw(t, once) {
    if (!once) {
      frame = requestAnimationFrame(draw);
      if (t - last < FRAME_MS || document.hidden || paused) return;
      last = t;
    }
    hand.x += (hand.goalX - hand.x) * 0.16;
    hand.y += (hand.goalY - hand.y) * 0.16;
    hand.power += ((t - hand.moved < 1600 ? 1 : 0) - hand.power) * 0.07;
    ripples = ripples.filter((r) => t - r.born < RIPPLE_MS);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) field[r * cols + c] = height(c * CELL, r * CELL, t);
    paint.fillStyle = BG;
    paint.fillRect(0, 0, width, tall);
    paint.beginPath();
    for (let i = 1; i <= LEVELS; i++) trace(0.16 + (i / (LEVELS + 1)) * 0.72);
    paint.lineWidth = 1.1;
    paint.strokeStyle = LINE;
    paint.stroke();
    if (hand.power > 0.02) {
      const glow = paint.createRadialGradient(hand.x, hand.y, 0, hand.x, hand.y, REACH * 1.5);
      glow.addColorStop(0, 'rgb(0 240 255 / 0.55)');
      glow.addColorStop(1, 'rgb(0 240 255 / 0)');
      paint.globalAlpha = hand.power;
      paint.strokeStyle = glow;
      paint.stroke();
      paint.globalAlpha = 1;
    }
    canvas.dataset.drawn = String(t);
  }

  function move(e) {
    hand.goalX = e.clientX; hand.goalY = e.clientY;
    if (hand.power < 0.01) { hand.x = e.clientX; hand.y = e.clientY; }
    hand.moved = performance.now();
  }
  function press(e) {
    move(e);
    ripples = [...ripples.slice(-3), { x: e.clientX, y: e.clientY, born: performance.now() }];
  }

  addEventListener('resize', size);
  size();
  if (!calm.matches) {
    addEventListener('pointermove', move, { passive: true });
    addEventListener('pointerdown', press, { passive: true });
    frame = requestAnimationFrame(draw);
  }
  window.contour = { pause: (on) => { paused = on; } };
})();
