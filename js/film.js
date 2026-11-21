// The opening's film: the rendered ident (two projectors throwing the Wall onto one screen, art/film/*), muted,
// played over the live picture in time with the ident's sound, then handed over to the live wall on the landing.
// The live opening keeps running underneath, so if the film cannot play (not loaded, an error, a stall) the
// procedural opening is simply what shows. Video time 0 is the ident's time 0 (the clips are cut that way).

const DIR = new URL('../film/', import.meta.url);
// The sync of the approved clip (assemble_v5.sh): the frames start at clip time 0 with Blender frame 1, the ident's
// time 0 is frame 12 (clip time 0.4 - 1/30), and the sound sits at -itsoffset 0.43. So the picture runs this much
// ahead of the sound's own clock; the web cuts start at frame 12, so video time = sound time + LEAD.
export const LEAD = 0.43 - (0.4 - 1 / 30);
// The T on the screen in the film's held frame, as a fraction of the video's height (measured on the D1 renders:
// its top bar to the stem's foot); it sits at the frame's centre in both cuts.
const T_FRAC = { wide: 196 / 720, portrait: 145 / 1280 };

export class Film {
  constructor(el, { exact = false } = {}) {
    this.el = el; this.exact = exact;
    this.flash = document.createElement('div'); this.flash.id = 'filmflash'; this.flash.setAttribute('aria-hidden', 'true'); el.after(this.flash);
    this.active = false; this.failed = false; this.done = false; this.seeking = null;
    this.portrait = innerHeight > innerWidth;
    const big = Math.max(innerWidth, innerHeight) * Math.min(2, devicePixelRatio || 1) > 1300; // 1080p from about 1366 wide up
    const name = this.portrait ? 'd1-portrait' : big ? 'd1-1080' : 'd1-720';
    const webm = el.canPlayType('video/webm; codecs="vp9"');
    el.muted = true; el.defaultMuted = true; el.playsInline = true; el.preload = 'auto';
    el.src = new URL(`${name}.${webm ? 'webm' : 'mp4'}`, DIR).href;
    el.addEventListener('error', () => this.fail());
    el.addEventListener('stalled', () => { if (this.active && el.readyState < 3) this.fail(); });
    el.addEventListener('waiting', () => { if (this.active && !this.exact) this.waitT = performance.now(); });
    el.addEventListener('playing', () => { this.waitT = 0; });
    // Phones (iOS Safari above all) ignore preload and stop at the metadata; a muted play and pause, which needs no
    // gesture, makes them buffer, so the film can be ready when the press comes.
    el.addEventListener('loadedmetadata', () => {
      if (this.exact || el.readyState >= 3) return;
      const q = el.play(); if (q) q.then(() => { if (!this.active) { el.pause(); el.currentTime = 0; } }).catch(() => {});
    }, { once: true });
    el.load();
  }

  get ready() { return !this.failed && this.el.readyState >= 3; }

  fail() {
    this.failed = true;
    if (this.active) { this.active = false; this.el.style.opacity = '0'; this.flash.style.opacity = '0'; try { this.el.pause(); } catch {} }
  }

  // The ident starts: play from its time 0 if the film is ready; otherwise the live opening shows.
  start() {
    if (!this.ready || this.done) return false;
    this.active = true; this.el.currentTime = 0; this.el.style.opacity = '1';
    if (!this.exact) {
      this.el.play().catch(() => this.fail());
      // a film that does not get going (a codec it cannot decode after all, a play the browser refuses quietly)
      // hands over to the live opening within a second rather than leaving the picture still
      this.startT = performance.now();
    }
    return true;
  }

  // Every frame of the opening: t, the video time to show (the sound's clock as heard, plus LEAD); fadeAt, fadeLen:
  // the handover to the live wall, on the same clock.
  update(t, fadeAt, fadeLen, liveT = 0) {
    if (!this.active) return;
    const el = this.el;
    if (this.waitT && performance.now() - this.waitT > 350) return this.fail(); // stuck buffering: hand over now
    if (this.startT) {
      if (el.currentTime > 0 && !el.paused) this.startT = 0;
      else if (performance.now() - this.startT > 1000) return this.fail();
    }
    const want = Math.max(0, t);
    if (this.exact) {
      if (Math.abs(el.currentTime - want) > 1e-3) { this.seeking = new Promise((r) => el.addEventListener('seeked', r, { once: true })); el.currentTime = want; }
    } else {
      const err = el.currentTime - want;
      if (Math.abs(err) > 0.15) el.currentTime = want;                         // far off: jump
      else el.playbackRate = Math.min(1.06, Math.max(0.94, 1 - err * 0.8));   // near: lean into time
    }
    // the handover is a cut inside a flash on the landing boom: the flash rises over two frames while the film pushes
    // in until its T is the size of the live T, the film is gone on the flash's peak, and the flash falls away off
    // the live wall, so nothing of the projection room (screen edge, haze, dust, its cells) dissolves over the wall
    const d = t - fadeAt, rise = 2 / 30;
    const e = Math.min(1, Math.max(0, (d + rise) / rise));
    el.style.opacity = d < 0 ? '1' : '0';
    this.flash.style.opacity = d < 0 ? (e * e).toFixed(3) : Math.max(0, 1 - d / fadeLen) ** 2 + '';
    if (liveT > 0 && el.videoHeight) {
      const cover = Math.max(el.clientWidth / el.videoWidth, el.clientHeight / el.videoHeight);
      const filmT = T_FRAC[this.portrait ? 'portrait' : 'wide'] * el.videoHeight * cover;
      el.style.transform = e > 0 ? `scale(${(1 + (liveT / filmT - 1) * e).toFixed(4)})` : '';
    }
    if (d >= fadeLen) this.finish();
  }

  finish() {
    this.active = false; this.done = true; this.el.style.opacity = '0'; this.flash.style.opacity = '0';
    try { this.el.pause(); } catch {}
  }

  // the room starts again later (the loop): the film is not replayed, the live opening plays
  reset() { this.done = true; }
}
