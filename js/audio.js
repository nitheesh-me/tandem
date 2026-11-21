// The score. Each of the eight people in the room is one part of the same four-bar groove (bass, kick, hats,
// arp, pad, clap, flute, drums in the default score), rendered offline as seamless loops (art/score/*, see
// CREDITS.txt), and mixed here, live, by what happens on screen and by the visitor:
//   - Tandem's hook, D5 F5 E5 A5 on a kalimba (Dexed, offline), runs through everything: the opening is a canon of
//     it, the late voice catching up pass by pass until unison; every act change is a variant of its sting,
//     landing on a beat; the host's part carries the hook and the arp's part its echo, so apart they play it in
//     canon, a dotted 8th behind, and locked in unison; when the host leaves, only the echo is left;
//   - the host's part is there first; each friend arrives with the hook in their own place's flavour, their
//     part coming in muffled until the film reaches their screen;
//   - apart, the parts are displaced by whole 16ths (in key), wide in the stereo field, late ones muffled, with
//     a tension pedal; together, they step back in and lock on a downbeat, the filter opening on the impact;
//   - while the room waits for the slowest, the drums stop, the rest plays on under a closing filter, the
//     hook holds on its third note over a suspended chord with a buffering pulse, and it all resolves together on the downbeat;
//   - the host leaving tape-stops their part; the end is a cadence and a warm outro that the picture breathes to;
//     after a while the room starts again, over a bridge;
//   - the pointer steers the arp and the flute (left and right, brighter toward the top), moving fast smears them
//     into a delay, scrolling makes air, holding raises the tension; clicks and pointer notes land on the grid.
// Nothing starts before a press or a key.

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
    progress.total = 1 + man.parts.length + 11 + s.notes.length + Object.keys(s.arrive).length + s.transitions.length; progress.done = 1;
    const get = async (f) => { const b = await dec.decodeAudioData(await (await fetch(new URL(f.replace(/\.wav$/, '.' + ext), base))).arrayBuffer()); progress.done++; return b; };
    const ident = await get(s.ident); progress.ident = ident;
    const parts = await Promise.all(man.parts.map((p) => get(p.file)));
    const [bed, impact, cadence, click, hold, tension, riser, outro, buffer, bridge, ...notes] = await Promise.all(
      [s.bed, s.impact, s.cadence, s.click, s.hold, s.tension, s.riser, s.outro, s.buffer, s.bridge, ...s.notes].map(get));
    const transitions = await Promise.all(s.transitions.map(async (t) => ({ b: await get(t.file), hit: t.hit })));
    const arrive = {}; await Promise.all(Object.entries(s.arrive).map(async ([h, f]) => { arrive[h] = await get(f); }));
    cache[name] = { man, parts, bed, impact, cadence, click, hold, tension, riser, outro, buffer, bridge, notes, arrive, ident, transitions };
    return cache[name];
  })();
  return pending[name];
}

const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);
const ss = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// per part (bass, kick, hats, arp, pad, clap, flute, drums): how many 16ths it is displaced when the room is apart,
// a light flam (seconds) for the rest, how loud it is before the lock, whether it is a drum, and where it sits
const DISP = [0, 0, 0, 3, 0, -1, 2, 0];
const FLAM = [0, 0.012, 0.022, 0, 0, 0, 0, -0.018];
const PRELOCK = [1, 0.45, 0.6, 1, 1, 0.7, 1, 0.8];
const DRUM = [false, true, true, false, false, true, false, true];
const PAN = [0, 0, -0.35, 0.3, 0, 0.15, -0.25, -0.4];
// the transitions' levels, measured (sound/analysis), so each sits at about the same loudness
const HOOK_ORDER = [0, 2, 1, 3]; // the pointer notes (D5 E5 F5 A5 D6) in the hook's order
const TR_GAIN = [1, 1, 1, 1, 1, 1, 1, 1]; // the transition files are levelled when rendered (sound/render.py LEVELS)
const OUTRO = 0.55; // the outro's level when a manifest does not say
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export class Sound {
  constructor(score = 'techno') { this.score = score; this.ctx = null; this.on = false; this.muted = false; this.level = 0; this.breath = 0; this.ready = false; }

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
    this.duck = ctx.createGain(); // a sidechain on events: the groove ducks under arrivals and hits
    this.partBus = ctx.createGain(); this.partBus.connect(this.duck); this.duck.connect(this.lockF); this.lockF.connect(glue);
    this.shotBus = ctx.createGain(); this.shotBus.gain.value = 0.55; this.shotBus.connect(glue);
    this.bedGain = ctx.createGain(); this.bedGain.gain.value = 0; this.bedGain.connect(glue);
    // the pointer's smear: a feedback delay the arp and the flute are sent into when the pointer moves fast
    this.smear = ctx.createGain(); this.smear.gain.value = 0;
    const dl = ctx.createDelay(2); const fb = ctx.createGain(); fb.gain.value = 0.42; const dlf = ctx.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 3200;
    this.smear.connect(dl); dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(glue); this.smearDelay = dl;
    // scrolling makes air: band-passed noise whose level follows how fast the piece is moving
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const nd = nb.getChannelData(0); let s0 = 0;
    for (let i = 0; i < nd.length; i++) { s0 = s0 * 0.6 + (this.rand() * 2 - 1) * 0.4; nd[i] = s0; }
    this.air = ctx.createBufferSource(); this.air.buffer = nb; this.air.loop = true;
    this.airF = ctx.createBiquadFilter(); this.airF.type = 'bandpass'; this.airF.frequency.value = 1400; this.airF.Q.value = 0.8;
    this.airG = ctx.createGain(); this.airG.gain.value = 0;
    this.air.connect(this.airF); this.airF.connect(this.airG); this.airG.connect(glue); this.air.start();
    this.on = true;
    const go = (sc) => this.begin(sc);
    if (cache[this.score]) go(cache[this.score]); else loadScore(this.score).then(go, () => {});
  }

  begin(sc) {
    const ctx = this.ctx; this.sc = sc; const m = sc.man;
    this.L = fin(m.loop, sc.parts[0].duration); this.beat = 60 / fin(m.bpm, 120); this.bar = this.beat * 4;
    this.makeup.gain.value = m.makeup || 1;
    this.smearDelay.delayTime.value = this.beat * 0.75;
    const t0 = this.t0 = ctx.currentTime + 0.12;
    this.parts = sc.parts.map((b, i) => {
      // each part: gain -> a lowpass (shut until the film reaches that friend; closed further when late) -> a
      // high shelf (the pointer's height, for the arp and the flute) -> pan
      const g = ctx.createGain(); g.gain.value = 0;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 350; f.Q.value = 0.5; g.connect(f);
      const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 2500; shelf.gain.value = 0; f.connect(shelf);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = PAN[i] || 0; shelf.connect(pan); pan.connect(this.partBus); } else shelf.connect(this.partBus);
      if (i === 3 || i === 6) { const send = ctx.createGain(); send.gain.value = 1; shelf.connect(send); send.connect(this.smear); }
      return { i, b, g, f, shelf, pan, src: null, sg: null, err: 0, target: 0, on: -1, cut: -1, panNow: PAN[i] || 0, gone: false };
    });
    this.parts.forEach((p) => this.restart(p, t0, 0));
    const bed = ctx.createBufferSource(); bed.buffer = sc.bed; bed.loop = true; bed.connect(this.bedGain); bed.start(t0);
    // the tension pedal runs with the groove's loop; the outro loops on its own, silent until the end
    this.tensionG = ctx.createGain(); this.tensionG.gain.value = 0; this.tensionG.connect(this.lockF);
    const ten = ctx.createBufferSource(); ten.buffer = sc.tension; ten.loop = true; ten.loopEnd = this.L; ten.connect(this.tensionG); ten.start(t0);
    // the outro, and an analyser on it alone, so the end screen can breathe with it
    this.outroG = ctx.createGain(); this.outroG.gain.value = 0; this.outroG.connect(this.makeup);
    this.outroA = ctx.createAnalyser(); this.outroA.fftSize = 512; this.outroBuf = new Uint8Array(this.outroA.fftSize); this.outroG.connect(this.outroA);
    const out = ctx.createBufferSource(); out.buffer = sc.outro; out.loop = true; out.connect(this.outroG); out.start(t0);
    this.lastBar = -1; this.lastBeat = -1; this.locked = false; this.hit = false; this.relockAt = 0; this.ending = false; this.last16 = -1; this.waiting = false;
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
    if (p.src) { const o = p.src, og = p.sg; og.gain.setValueAtTime(1, when); og.gain.linearRampToValueAtTime(0, when + 0.012); try { o.stop(when + 0.05); } catch {} o.onended = () => { try { og.disconnect(); } catch {} }; }
    p.src = s; p.sg = sg; p.err = err;
  }

  setMuted(m) { this.muted = m; if (this.ctx && this.out) this.out.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.12); }

  // The opening's sonic logo, timed to the picture; it needs only its own file, which loads first.
  ident(offset = 0) {
    const b = progress.ident || (cache[this.score] && cache[this.score].ident);
    if (!this.ctx || !b) return;
    const s = this.ctx.createBufferSource(); s.buffer = b; const g = this.ctx.createGain(); g.gain.value = 1.0;
    s.connect(g); g.connect(this.shotBus); this.identAt = this.ctx.currentTime + 0.03 - offset; s.start(this.identAt + offset, offset);
  }

  nextGrid(t, unit) { return this.t0 + Math.ceil((t - this.t0) / unit - 1e-6) * unit; }

  // Every frame. s: { present and filled (0..1, per person), together, hold, p, intro, mark, dt,
  //                   px, py (the pointer, 0..1), pspeed (screens a second), scroll (the piece's speed) }
  update(s) {
    if (!this.ready) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const ending = s.mark > 0.35;
    const six = this.beat / 4;
    const apart = this.locked ? 0 : clamp(1 - s.together, 0, 1);
    const px = fin(s.px, 0.5), py = fin(s.py, 0.5), sp = clamp(fin(s.pspeed, 0), 0, 3);
    this.parts.forEach((p, i) => {
      // lateness, made musical: whole 16ths for the arp, the clap and the flute, light flams for the rest
      p.target = Math.round(DISP[i] * apart) * six + FLAM[i] * apart;
      const fill = s.filled[i] || 0;
      const late = Math.min(1, Math.abs(p.err) / (2 * six)); // a part that is late sounds far away: quieter, muffled
      let lvl = (s.present[i] || 0) * (0.3 + 0.7 * fill) * (1 - 0.5 * late);
      if (p.gone || ending) lvl = 0;
      if (this.waiting) lvl = DRUM[i] ? 0 : lvl * 0.85; // waiting: the drums stop, the rest plays on under the filter
      if (!this.locked && !this.waiting) lvl *= PRELOCK[i] ?? 1;
      p.want = lvl;
      if (now >= (this.muteUntil || 0) && Math.abs(lvl - p.on) > 0.01) { p.g.gain.setTargetAtTime(lvl, now, ending ? 1.5 : this.waiting ? 0.06 : 0.3); p.on = lvl; }
      const cut = Math.min(350 + 19000 * fill * fill, 700 + 14000 * (1 - late) ** 2);
      if (Math.abs(cut - p.cut) > 50) { p.f.frequency.setTargetAtTime(cut, now, 0.25); p.cut = cut; }
      // where it sits: wider apart than together; the arp and the flute follow the pointer left and right
      let pan = (PAN[i] || 0) * (0.6 + 1.0 * apart);
      if (i === 3 || i === 6) pan = pan * 0.4 + (px - 0.5) * 1.3 * (i === 3 ? 1 : -0.7);
      pan = clamp(pan, -1, 1);
      if (p.pan && Math.abs(pan - p.panNow) > 0.01) { p.pan.pan.setTargetAtTime(pan, now, 0.12); p.panNow = pan; }
      if (i === 3 || i === 6) p.shelf.gain.setTargetAtTime(-8 + 14 * (1 - py), now, 0.12); // brighter toward the top
    });
    // the pointer moving fast smears the arp and the flute into a delay; scrolling makes air
    this.smear.gain.setTargetAtTime(Math.min(0.7, sp * 0.45), now, sp > 0.1 ? 0.05 : 0.6);
    const sc = Math.min(1, Math.abs(fin(s.scroll, 0)) * 3);
    this.airG.gain.setTargetAtTime(sc * 0.09, now, 0.12); this.airF.frequency.setTargetAtTime(900 + 3500 * sc, now, 0.12);
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
    // while waiting, a soft buffering pulse on every beat
    const bt = this.nextGrid(now + 0.04, this.beat);
    if (bt !== this.lastBeat) { this.lastBeat = bt; if (this.waiting && bt > this.waitAt + 0.01) this.shot(this.sc.buffer, bt, 0.9, 0.35); }
    this.bedGain.gain.setTargetAtTime(ending ? 0 : s.intro > 0.2 ? 0.9 : 0.25, now, 0.6);
    // tension under the room while it is apart (holding raises it), fading as the room comes together
    const ten = this.locked || this.waiting || ending ? 0 : 0.6 * ss(0.17, 0.3, s.p) * (0.4 + 0.6 * apart) + 0.35 * s.hold;
    this.tensionG.gain.setTargetAtTime(ten, now, this.locked ? 0.15 : 0.6);
    // the lock: the room is in sync, so on a downbeat everything starts together, the filter opens, it hits; a riser
    // rolls up to that downbeat
    if (!this.locked && !this.waiting && s.together > 0.92 && s.p > 0.45 && now >= this.relockAt) {
      let T = this.nextGrid(now + 0.06, this.bar);
      if (!this.hit && T - now < 1.5) T += this.bar;
      this.locked = true;
      this.parts.forEach((p) => { if (!p.gone) this.restart(p, T, 0); });
      if (!this.hit) {
        this.shot(this.sc.impact, T, 0.9); this.hit = true; this.pump(T, 0.5);
        const len = this.sc.riser.duration, st = Math.max(now + 0.02, T - len);
        const r = ctx.createBufferSource(); r.buffer = this.sc.riser; const g = ctx.createGain(); g.gain.value = 0.55;
        r.connect(g); g.connect(this.shotBus); r.start(st, len - (T - st));
      }
      this.lockF.frequency.setTargetAtTime(19000, T, 0.04);
    } else if (this.locked && !this.waiting && s.together < 0.7) this.locked = false;
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
    // the outro's breath, for the end screen: its level, smoothed
    if (this.ending && this.outroA) {
      this.outroA.getByteTimeDomainData(this.outroBuf); let q = 0; for (let i = 0; i < this.outroBuf.length; i += 4) { const x = (this.outroBuf[i] - 128) / 128; q += x * x; }
      const lv = Math.min(1, Math.sqrt(q / (this.outroBuf.length / 4)) * 9);
      this.breath += (lv - this.breath) * 0.06;
    } else this.breath *= 0.95;
  }

  // a short duck of the groove (a sidechain), on a hit
  pump(T, depth = 0.4, rel = 0.35) {
    const g = this.duck.gain; g.setValueAtTime(1, T); g.linearRampToValueAtTime(1 - depth, T + 0.01); g.setTargetAtTime(1, T + 0.02, rel / 3);
  }

  shot(buf, when, gain = 1, pan = 0) {
    const s = this.ctx.createBufferSource(); s.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = gain;
    const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    s.connect(g); if (p) { p.pan.value = clamp(fin(pan), -1, 1); g.connect(p); p.connect(this.shotBus); } else g.connect(this.shotBus);
    s.start(when); s.onended = () => { try { g.disconnect(); if (p) p.disconnect(); } catch {} };
    return s;
  }

  // An act begins: its own transition sound, its hit landing on the next beat it can reach.
  transition(k) {
    if (!this.ready) return; const t = this.sc.transitions[k - 1]; if (!t) return;
    const now = this.ctx.currentTime, T = this.nextGrid(now + t.hit + 0.03, this.beat);
    const st = Math.max(now + 0.01, T - t.hit);
    const s = this.shot(t.b, st, TR_GAIN[k - 1] || 1, 0);
    if (t.hit > 0.3 && [2, 4, 7].includes(k)) this.pump(T, 0.35);
    return s;
  }

  // The pointer crosses the wall: one note, on the next 8th, higher toward the top of the screen.
  pointerNote(x, y, strength = 1) {
    if (!this.ready || this.muted) return;
    const now = this.ctx.currentTime;
    const T = this.nextGrid(now + 0.02, this.beat / 2);
    if (T < this.last16 + this.beat - 1e-6) return; this.last16 = T; // at most one a beat
    const notes = this.sc.notes; const k = clamp(Math.floor((1 - y) * notes.length), 0, notes.length - 1);
    this.shot(notes[k], T, 0.15 + 0.15 * Math.min(1, strength), (x - 0.5) * 1.2);
  }

  // A click: a bell on the next 8th.
  tick(pan = 0) {
    if (!this.ready || this.muted) return;
    this.shot(this.sc.click, this.nextGrid(this.ctx.currentTime + 0.02, this.beat / 2), 0.7, pan);
  }

  lock() {} // the lock is decided in update(), on the beat

  // The invite goes out toward one friend: the hook's next note on the next 8th, panned that way.
  hop(h, pan = 0) {
    if (!this.ready) return;
    const notes = this.sc.notes, T = this.nextGrid(this.ctx.currentTime + 0.02, this.beat / 2);
    const s = this.ctx.createBufferSource(); s.buffer = notes[HOOK_ORDER[h % 4]]; s.playbackRate.value = h >= 4 ? 2 : 1; // the hook, D F E A, then an octave up
    const g = this.ctx.createGain(); g.gain.value = 0.6; const p = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
    s.connect(g); if (p) { p.pan.value = clamp(fin(pan), -1, 1); g.connect(p); p.connect(this.shotBus); } else g.connect(this.shotBus);
    s.start(T);
  }

  // A friend lands: their place's phrase on the next beat, and the bed ducks under it.
  arrive(k, pan = 0) {
    if (!this.ready) return; const h = this.sc.man.parts[k] && this.sc.man.parts[k].handle; const b = this.sc.arrive[h];
    const T = this.nextGrid(this.ctx.currentTime + 0.02, this.beat);
    if (b) this.shot(b, T, 0.8, pan);
    this.bedGain.gain.setValueAtTime(this.bedGain.gain.value, T); this.bedGain.gain.linearRampToValueAtTime(0.08, T + 0.05); this.bedGain.gain.setTargetAtTime(0.25, T + 0.4, 0.4);
  }

  // The room waits for the slowest: from the next beat the drums stop, the rest plays on as the filter closes, a
  // suspended chord holds, and a soft pulse marks the beats: the room is waiting, not broken.
  wait() {
    if (!this.ready || this.waiting) return;
    const now = this.ctx.currentTime, T = this.nextGrid(now + 0.02, this.beat);
    this.waiting = true; this.waitAt = T;
    this.lockF.frequency.cancelScheduledValues(now); this.lockF.frequency.setValueAtTime(this.lockF.frequency.value, now); this.lockF.frequency.setTargetAtTime(650, T, 0.7);
    this.holdSrc = this.ctx.createBufferSource(); this.holdSrc.buffer = this.sc.hold; this.holdG = this.ctx.createGain(); this.holdG.gain.value = 0.9;
    this.holdSrc.connect(this.holdG); this.holdG.connect(this.shotBus); this.holdSrc.start(T);
  }
  // ...and resolves together on the next downbeat: the filter opens, the drums come back, a soft hit
  release(hit = true) {
    if (!this.ready || !this.waiting) return;
    const now = this.ctx.currentTime, T = this.nextGrid(now + 0.05, this.bar);
    this.waiting = false; this.muteUntil = T;
    this.parts.forEach((p) => {
      if (p.gone) return;
      this.restart(p, T, 0);
      if (DRUM[p.i]) { p.g.gain.cancelScheduledValues(now); p.g.gain.setValueAtTime(0, now); p.g.gain.setValueAtTime(1, T); p.on = 1; }
    });
    this.lockF.frequency.cancelScheduledValues(now); this.lockF.frequency.setValueAtTime(this.lockF.frequency.value, now); this.lockF.frequency.setTargetAtTime(19000, T, 0.03);
    if (this.holdG) { this.holdG.gain.setTargetAtTime(0, T, 0.25); try { this.holdSrc.stop(T + 2); } catch {} }
    if (hit) { this.shot(this.sc.impact, T, 0.5); this.pump(T, 0.3); }
  }

  // The host leaves: their part tape-stops; the others stumble for a bar and fall back in on the downbeat after.
  hostLeaves() {
    if (!this.ready) return; const p = this.parts[0]; if (p.gone) return;
    const now = this.ctx.currentTime; p.gone = true;
    p.src.playbackRate.cancelScheduledValues(now); p.src.playbackRate.setValueAtTime(1, now); p.src.playbackRate.exponentialRampToValueAtTime(0.04, now + 0.9);
    p.g.gain.cancelScheduledValues(now); p.g.gain.setValueAtTime(p.g.gain.value, now); p.g.gain.linearRampToValueAtTime(0, now + 0.95); p.on = 0;
    const T = this.nextGrid(now + 0.05, this.beat), six = this.beat / 4;
    this.locked = false; this.relockAt = T + this.bar * 0.75;
    this.parts.forEach((q, i) => { if (i && !q.gone) this.restart(q, T, i === 3 ? six : i === 6 ? -six : 0); }); // the arp and the flute trip by a 16th
    this.lockF.frequency.setTargetAtTime(2400, now, 0.08);
  }
  hostBack() {
    if (!this.ready) return; const p = this.parts[0]; if (!p.gone) return;
    p.gone = false; p.on = -1; this.restart(p, this.nextGrid(this.ctx.currentTime + 0.05, this.beat), 0);
  }

  // The room starts again: the bridge (its hit `bridgeHit` seconds in, where the mark breaks apart on screen),
  // the outro fading under it, and the groove reset, silent, ready for the invite.
  bridge() {
    if (!this.ready) return 0;
    const now = this.ctx.currentTime;
    this.shot(this.sc.bridge, now + 0.03, 1.6, 0);
    this.outroG.gain.cancelScheduledValues(now); this.outroG.gain.setValueAtTime(this.outroG.gain.value, now); this.outroG.gain.setTargetAtTime(0, now, 1.2);
    this.ending = false; this.locked = false; this.hit = false; this.waiting = false; this.relockAt = 0;
    this.parts.forEach((p) => { p.gone = false; p.g.gain.cancelScheduledValues(now); p.g.gain.setTargetAtTime(0, now, 0.4); p.on = 0; this.restart(p, this.nextGrid(now + 0.05, this.bar), 0); });
    return this.sc.man.shots.bridgeHit || 2.5;
  }
}
