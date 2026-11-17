// The score. Each of the eight people in the room is one part of the same four-bar groove (bass, kick, hats,
// arp, pad, clap, bell, shaker in the default score), rendered offline as seamless loops (art/score/*, see
// CREDITS.txt). The host's part is there first, alone, while the invite hops from screen to screen as single
// pink notes. Each friend arrives with a short phrase in their own place's flavour, and their part comes in
// late and muffled, a hollow frame of itself; it opens up when the film reaches their screen. Apart, the parts
// play each at its own offset: the room is literally out of time, flams and phasing like a Steve Reich phase
// piece. As the room comes together the parts are nudged back into phase (a little faster or slower, so they
// glide in; whole beats at a time when they are far out), and when it is in sync the groove locks on the next
// downbeat: everything restarts exactly together, the filter opens and the impact hits. While the room waits
// for one friend who is buffering, the groove holds on a fermata and releases together on a downbeat. When the
// host leaves, their part tape-stops; the others stumble for a bar and fall back in. At the end a cadence
// resolves under the mark. Pointer notes land on the 16th grid. Nothing starts before a press or a key.

const ROOT = new URL('../score/', import.meta.url);
const cache = {}; // decoded buffers per score, shared by the live and the offline (recording) contexts

function pickExt() {
  try { const a = document.createElement('audio'); if (a.canPlayType('audio/ogg; codecs=opus')) return 'ogg'; } catch {}
  return 'm4a';
}

// How far the score has loaded, for the opening's loading line: files done of files to fetch, and whether the
// ident (fetched first, so the opening can play long before the rest arrives on a slow network) is ready.
export const progress = { done: 0, total: 1, ident: null };
const pending = {};
export function loadScore(name) {
  if (cache[name]) return Promise.resolve(cache[name]);
  if (pending[name]) return pending[name];
  pending[name] = (async () => {
    const base = new URL(`${name}/`, ROOT);
    const man = await (await fetch(new URL('manifest.json', base))).json();
    const ext = pickExt();
    const dec = new OfflineAudioContext(2, 1, man.sampleRate);
    const s = man.shots;
    progress.total = 1 + man.parts.length + 9 + s.notes.length + Object.keys(s.arrive).length; progress.done = 1;
    const get = async (f) => { const b = await dec.decodeAudioData(await (await fetch(new URL(f.replace(/\.wav$/, '.' + ext), base))).arrayBuffer()); progress.done++; return b; };
    const ident = await get(s.ident); progress.ident = ident;
    const parts = await Promise.all(man.parts.map((p) => get(p.file)));
    const [bed, impact, cadence, click, hold, tension, riser, outro, ...notes] = await Promise.all([get(s.bed), get(s.impact), get(s.cadence), get(s.click), get(s.hold), get(s.tension), get(s.riser), get(s.outro), ...s.notes.map(get)]);
    const arrive = {}; await Promise.all(Object.entries(s.arrive).map(async ([h, f]) => { arrive[h] = await get(f); }));
    cache[name] = { man, parts, bed, impact, cadence, click, hold, tension, riser, outro, notes, arrive, ident };
    return cache[name];
  })();
  return pending[name];
}

const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// per part (bass, kick, hats, arp, pad, clap, bell, shaker): how many 16ths it is displaced when the room is apart,
// a light flam (seconds) for the rest, and how loud it is before the lock
const DISP = [0, 0, 0, 3, 0, -1, 2, 0];
const FLAM = [0, 0.012, 0.022, 0, 0, 0, 0, -0.018];
const PRELOCK = [1, 0.45, 0.6, 1, 1, 0.7, 1, 0.8];
const OUTRO = 0.55; // the outro's level
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Sound {
  constructor(score = 'techno') { this.score = score; this.ctx = null; this.on = false; this.muted = false; this.level = 0; this.ready = false; }

  // `given`: an OfflineAudioContext when a session is rendered for a recording (load the score first)
  start(given) {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC && !given) return;
    const ctx = this.ctx = given || new AC({ latencyHint: 'interactive' });
    this.rand = rng(11);
    // parts -> the lock filter -> glue -> make-up -> a peak catcher -> out
    this.out = ctx.createGain(); this.out.gain.value = this.muted ? 0 : 1;
    const glue = ctx.createDynamicsCompressor(); glue.threshold.value = -14; glue.ratio.value = 2.5; glue.attack.value = 0.01; glue.release.value = 0.12; glue.knee.value = 6;
    const peak = ctx.createDynamicsCompressor(); peak.threshold.value = -4; peak.ratio.value = 20; peak.attack.value = 0.001; peak.release.value = 0.08; peak.knee.value = 0;
    this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 256; this.buf = new Uint8Array(this.analyser.fftSize);
    this.makeup = ctx.createGain(); this.makeup.gain.value = 1;
    glue.connect(this.makeup); this.makeup.connect(peak); peak.connect(this.out); this.out.connect(this.analyser); this.analyser.connect(ctx.destination);
    this.lockF = ctx.createBiquadFilter(); this.lockF.type = 'lowpass'; this.lockF.frequency.value = 900; this.lockF.Q.value = 0.9;
    this.partBus = ctx.createGain(); this.partBus.connect(this.lockF); this.lockF.connect(glue);
    this.shotBus = ctx.createGain(); this.shotBus.gain.value = 0.55; this.shotBus.connect(glue);
    this.bedGain = ctx.createGain(); this.bedGain.gain.value = 0; this.bedGain.connect(glue);
    this.on = true;
    const go = (sc) => this.begin(sc);
    if (cache[this.score]) go(cache[this.score]); else loadScore(this.score).then(go, () => {});
  }

  begin(sc) {
    const ctx = this.ctx; this.sc = sc; const m = sc.man;
    this.L = fin(m.loop, sc.parts[0].duration); this.beat = 60 / fin(m.bpm, 120); this.bar = this.beat * 4;
    this.makeup.gain.value = m.makeup || 1;
    const t0 = this.t0 = ctx.currentTime + 0.12;
    this.parts = sc.parts.map((b, i) => {
      // each part: gain -> a lowpass that stays shut until the film reaches that friend's screen -> pan
      const g = ctx.createGain(); g.gain.value = 0;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 350; f.Q.value = 0.5; g.connect(f);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = [0, 0, -0.15, 0.2, 0, 0.05, 0.25, -0.3][i] || 0; f.connect(pan); pan.connect(this.partBus); } else f.connect(this.partBus);
      return { i, b, g, f, src: null, sg: null, err: 0, target: 0, rate: 1, on: -1, cut: -1, gone: false };
    });
    this.parts.forEach((p) => this.restart(p, t0, 0));
    const bed = ctx.createBufferSource(); bed.buffer = sc.bed; bed.loop = true; bed.connect(this.bedGain); bed.start(t0);
    // the tension pedal runs with the groove's loop; the outro loops on its own, silent until the end
    this.tensionG = ctx.createGain(); this.tensionG.gain.value = 0; this.tensionG.connect(this.lockF);
    const ten = ctx.createBufferSource(); ten.buffer = sc.tension; ten.loop = true; ten.loopEnd = this.L; ten.connect(this.tensionG); ten.start(t0);
    this.outroG = ctx.createGain(); this.outroG.gain.value = 0; this.outroG.connect(this.makeup);
    const out = ctx.createBufferSource(); out.buffer = sc.outro; out.loop = true; out.connect(this.outroG); out.start(t0);
    this.lastBar = -1; this.locked = false; this.hit = false; this.relockAt = 0; this.ending = false; this.last16 = -1; this.waiting = false;
    this.ready = true;
  }

  // (re)start a part's loop at `when`, `err` seconds late against the room's clock, with a short crossfade
  restart(p, when, err) {
    const ctx = this.ctx; const L = this.L;
    const master = ((when - this.t0) % L + L) % L;
    const pos = ((master - err) % L + L) % L;
    const s = ctx.createBufferSource(); s.buffer = p.b; s.loop = true; s.loopStart = 0; s.loopEnd = L;
    const sg = ctx.createGain(); sg.gain.setValueAtTime(0, when); sg.gain.linearRampToValueAtTime(1, when + 0.012);
    s.connect(sg); sg.connect(p.g); s.start(when, pos);
    if (p.src) { const o = p.src, og = p.sg; og.gain.setValueAtTime(1, when); og.gain.linearRampToValueAtTime(0, when + 0.012); try { o.stop(when + 0.05); } catch {} }
    p.src = s; p.sg = sg; p.err = err; p.rate = 1;
  }

  setMuted(m) { this.muted = m; if (this.ctx && this.out) this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.12); }

  // The opening's sonic logo, two hits, timed to the picture; it needs only its own file, which loads first.
  ident() {
    const b = progress.ident || (cache[this.score] && cache[this.score].ident);
    if (!this.ctx || !b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; const g = this.ctx.createGain(); g.gain.value = 1.0;
    s.connect(g); g.connect(this.shotBus); s.start(this.ctx.currentTime + 0.03);
  }

  nextGrid(t, unit) { return this.t0 + Math.ceil((t - this.t0) / unit - 1e-6) * unit; }

  // Every frame. s: { offsets (s, per person), present and filled (0..1, per person), together, hold, p, intro, mark, dt }
  update(s) {
    if (!this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const ending = s.mark > 0.35;
    const six = this.beat / 4;
    const apart = this.locked ? 0 : Math.max(0, Math.min(1, 1 - s.together));
    this.parts.forEach((p, i) => {
      // lateness, made musical: a part is displaced by whole 16ths (only the arp, the clap and the bell, at most
      // three 16ths), the others by a light flam; the room coming together takes the displacement down a 16th at a time
      p.target = Math.round(DISP[i] * apart) * six + FLAM[i] * apart;
      // present: the friend has arrived; filled: the film has reached them, so their part opens up
      const fill = s.filled[i] || 0;
      const late = Math.min(1, Math.abs(p.err) / (2 * six)); // a part that is late sounds far away: quieter, muffled
      let lvl = (s.present[i] || 0) * (0.3 + 0.7 * fill) * (1 - 0.5 * late);
      if (p.gone || this.waiting || ending) lvl = 0;
      if (!this.locked) lvl *= PRELOCK[i] ?? 1; // before the lock the drums hold back: the drop is the payoff
      p.want = lvl;
      if (now < (this.muteUntil || 0)) return; // released on a downbeat that has not come yet
      if (Math.abs(lvl - p.on) > 0.01) { p.g.gain.setTargetAtTime(lvl, now, ending ? 1.5 : this.waiting ? 0.03 : 0.3); p.on = lvl; }
      const cut = Math.min(350 + 19000 * fill * fill, 700 + 14000 * (1 - late) ** 2);
      if (Math.abs(cut - p.cut) > 50) { p.f.frequency.setTargetAtTime(cut, now, 0.25); p.cut = cut; }
    });
    // on each downbeat, every displaced part steps one 16th toward where it should be (no pitch bends, no smear)
    const nb = this.nextGrid(now + 0.04, this.bar);
    if (nb !== this.lastBar) {
      this.lastBar = nb;
      this.parts.forEach((p) => {
        if (p.gone) return;
        const d = p.target - p.err;
        if (Math.abs(d) > 0.004) this.restart(p, nb, Math.abs(d) > six * 0.6 && p.want > 0.02 ? p.err + Math.sign(d) * six : p.target); // a silent part goes straight there
      });
    }
    this.bedGain.gain.setTargetAtTime(ending ? 0 : s.intro > 0.2 ? 0.9 : 0.25, now, 0.6);
    // tension under the room while it is apart: an open pedal, fading as the room comes together
    this.tensionG.gain.setTargetAtTime(this.locked || this.waiting || ending ? 0 : 0.6 * ss(0.17, 0.3, s.p) * (0.4 + 0.6 * apart), now, this.locked ? 0.15 : 0.6);
    // the lock: the room is in sync, so on a downbeat everything starts together, the filter opens, it hits; a riser
    // rolls up to that downbeat
    if (!this.locked && !this.waiting && s.together > 0.92 && s.p > 0.45 && now >= this.relockAt) {
      let T = this.nextGrid(now + 0.06, this.bar);
      if (!this.hit && T - now < 1.5) T += this.bar;
      this.locked = true;
      this.parts.forEach((p) => { if (!p.gone) this.restart(p, T, 0); });
      if (!this.hit) {
        this.shot(this.sc.impact, T, 0.9); this.hit = true;
        const len = this.sc.riser.duration, st = Math.max(now + 0.02, T - len);
        const r = ctx.createBufferSource(); r.buffer = this.sc.riser; const g = ctx.createGain(); g.gain.value = 0.55;
        r.connect(g); g.connect(this.shotBus); r.start(st, len - (T - st));
      }
      this.lockF.frequency.setTargetAtTime(19000, T, 0.04);
    } else if (this.locked && s.together < 0.7) this.locked = false;
    if (s.together < 0.5) this.hit = false;
    if (!this.locked) this.lockF.frequency.setTargetAtTime(Math.min(19000, 1800 + 3000 * s.together * s.together + 2500 * s.hold), now, 0.2);
    // the end: a cadence on the next downbeat, then the outro, quiet and warm, for as long as the page stays open
    if (ending && !this.ending) {
      this.ending = true;
      const T = this.nextGrid(now + 0.06, this.bar);
      this.shot(this.sc.cadence, T, 0.8);
      this.outroG.gain.cancelScheduledValues(now); this.outroG.gain.setValueAtTime(this.outroG.gain.value, now);
      this.outroG.gain.setTargetAtTime(this.sc.man.outroGain || OUTRO, T + 3.5, 2.5);
    } else if (!ending && s.mark < 0.15 && this.ending) { this.ending = false; this.outroG.gain.cancelScheduledValues(now); this.outroG.gain.setTargetAtTime(0, now, 0.8); }
    if (this.analyser) { this.analyser.getByteTimeDomainData(this.buf); let q = 0; for (let i = 0; i < this.buf.length; i += 4) { const x = (this.buf[i] - 128) / 128; q += x * x; } this.level = Math.sqrt(q / (this.buf.length / 4)); }
  }

  shot(buf, when, gain = 1, pan = 0) {
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = gain;
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    s.connect(g); if (p) { p.pan.value = Math.max(-1, Math.min(1, fin(pan))); g.connect(p); p.connect(this.shotBus); } else g.connect(this.shotBus);
    s.start(when);
  }

  // The pointer crosses the wall: one note, on the next 16th, higher toward the top of the screen.
  pointerNote(x, y, strength = 1) {
    if (!this.ready || this.muted) return;
    const now = this.ctx.currentTime;
    const T = this.nextGrid(now + 0.02, this.beat / 2);
    if (T < this.last16 + this.beat - 1e-6) return; this.last16 = T; // at most one a beat, on an 8th
    const notes = this.sc.notes; const k = Math.max(0, Math.min(notes.length - 1, Math.floor((1 - y) * notes.length)));
    this.shot(notes[k], T, 0.15 + 0.15 * Math.min(1, strength), (x - 0.5) * 1.2);
  }

  // A click: a bell on the next 8th.
  tick(pan = 0) {
    if (!this.ready || this.muted) return;
    this.shot(this.sc.click, this.nextGrid(this.ctx.currentTime + 0.02, this.beat / 2), 0.7, pan);
  }

  lock() {} // the lock is decided in update(), on the beat

  // The invite reaches the next screen: one pink note on the next 8th, climbing as it goes.
  hop(h, pan = 0) {
    if (!this.ready) return;
    const notes = this.sc.notes, T = this.nextGrid(this.ctx.currentTime + 0.02, this.beat / 2);
    const s = this.ctx.createBufferSource(); s.buffer = notes[h % notes.length]; s.playbackRate.value = h >= notes.length ? 2 : 1;
    const g = this.ctx.createGain(); g.gain.value = 0.7; const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    s.connect(g); if (p) { p.pan.value = Math.max(-1, Math.min(1, fin(pan))); g.connect(p); p.connect(this.shotBus); } else g.connect(this.shotBus);
    s.start(T);
  }

  // A friend lands: their place's phrase on the next beat.
  arrive(k, pan = 0) {
    if (!this.ready) return; const h = this.sc.man.parts[k] && this.sc.man.parts[k].handle; const b = this.sc.arrive[h];
    if (b) this.shot(b, this.nextGrid(this.ctx.currentTime + 0.02, this.beat), 0.8, pan);
  }

  // The room waits for the slowest: on the next beat the groove stops and the home chord holds, a fermata.
  wait() {
    if (!this.ready || this.waiting) return;
    const T = this.nextGrid(this.ctx.currentTime + 0.02, this.beat);
    this.waiting = true; this.waitAt = T;
    this.parts.forEach((p) => { p.g.gain.cancelScheduledValues(T); p.g.gain.setTargetAtTime(0, T, 0.03); p.on = 0; });
    this.holdSrc = this.ctx.createBufferSource(); this.holdSrc.buffer = this.sc.hold; this.holdG = this.ctx.createGain(); this.holdG.gain.value = 0.9;
    this.holdSrc.connect(this.holdG); this.holdG.connect(this.shotBus); this.holdSrc.start(T);
  }
  // ...and releases together on the next downbeat
  release(hit = true) {
    if (!this.ready || !this.waiting) return;
    const T = this.nextGrid(this.ctx.currentTime + 0.05, this.bar);
    this.waiting = false; this.muteUntil = T;
    const now = this.ctx.currentTime;
    this.parts.forEach((p) => {
      if (!p.gone) this.restart(p, T, 0);
      const w = 1; // by the waiting act every friend is here and has the film
      p.g.gain.cancelScheduledValues(now); p.g.gain.setValueAtTime(0, now); p.g.gain.setValueAtTime(p.gone ? 0 : w, T); p.on = p.gone ? 0 : w;
    });
    if (this.holdG) { this.holdG.gain.setTargetAtTime(0, T, 0.08); try { this.holdSrc.stop(T + 1); } catch {} }
    if (hit) this.shot(this.sc.impact, T, 0.45);
  }

  // The host leaves: their part tape-stops; the others stumble for a bar and fall back in on the downbeat after.
  hostLeaves() {
    if (!this.ready) return; const p = this.parts[0]; if (p.gone) return;
    const now = this.ctx.currentTime; p.gone = true;
    p.src.playbackRate.cancelScheduledValues(now); p.src.playbackRate.setValueAtTime(p.rate, now); p.src.playbackRate.exponentialRampToValueAtTime(0.04, now + 0.9);
    p.g.gain.cancelScheduledValues(now); p.g.gain.setValueAtTime(p.g.gain.value, now); p.g.gain.linearRampToValueAtTime(0, now + 0.95); p.on = 0;
    const T = this.nextGrid(now + 0.05, this.beat), six = this.beat / 4;
    this.locked = false; this.relockAt = T + this.bar * 0.75;
    this.parts.forEach((q, i) => { if (i && !q.gone) this.restart(q, T, i === 3 ? six : i === 6 ? -six : 0); }); // the arp and the bell trip by a 16th
    this.lockF.frequency.setTargetAtTime(2400, now, 0.08);
  }
  hostBack() {
    if (!this.ready) return; const p = this.parts[0]; if (!p.gone) return;
    p.gone = false; p.on = -1; this.restart(p, this.nextGrid(this.ctx.currentTime + 0.05, this.beat), 0);
  }
}
