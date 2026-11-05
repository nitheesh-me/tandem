// The Station. Networking, Room and swarm run here, and so does storage, because
// OPFS sync access handles exist only in a dedicated Worker. It also sets the
// pace for the page: a Worker's timers keep running in a hidden tab.
import init, { Tandem, chunk_ok, manifest_root } from './pkg/tandem_web.js';

const CHUNK = 4 * 1024 * 1024;
const SLICE = 2 * 1024 * 1024;
const TICK_MS = 200;
// Chunks fetched from a mirror at once. Each is 4 MiB, so this is also the
// memory in flight.
const MIRROR_FETCHES = 4;
// A fetch that delivers nothing for this long is given up. A slow one that
// keeps delivering is let finish: aborting it would throw its bytes away.
const MIRROR_PATIENCE_MS = 15_000;
// A host that failed rests this long before it gets chunks again.
const MIRROR_REST_MS = 60_000;

let station = null;
let store = null;
let opening = null;
let options = {};
// Which film is open or opening, and a count that tells a stale open to stop.
let openRoot = null;
let filmGeneration = 0;
let retryAt = 0;
let leaving = false;
/** A name chosen in the page, kept for a Station still joining. */
let renamed = null;
/** The page's choice to be named, kept for a Station still joining. */
let listedLater = null;
let wantItem = null;

// The wasm is the biggest thing the page loads, so it starts at once, with
// progress for the page. The copy that streams into the compiler is the
// browser's own response, so the browser can keep the compiled code for the
// next visit; a clone of it is only counted.
const WASM_URL = new URL('./pkg/tandem_web_bg.wasm', import.meta.url);
// The wasm's size, for progress where the server compresses it (GitHub Pages
// does) and so sends no usable length. Update it with pkg/; it only steers a bar.
const WASM_BYTES = 3_219_430;
let wasmReady = null;
function loadWasm() {
  if (wasmReady) return wasmReady;
  const started = performance.now();
  wasmReady = (async () => {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error(`wasm download: HTTP ${res.status}`);
    // With compression, Content-Length counts the compressed bytes, so it is no total.
    const encoded = res.headers.get('content-encoding');
    const total = encoded && encoded !== 'identity' ? WASM_BYTES : Number(res.headers.get('content-length') ?? 0) || WASM_BYTES;
    let got = 0;
    const counted = (async () => {
      const reader = res.clone().body.getReader();
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        const now = performance.now();
        if (now - last > 100) { last = now; postMessage({ t: 'wasm', got, total: Math.max(total, got) }); }
      }
    })();
    await init({ module_or_path: res });
    await counted.catch(() => {});
    const entry = performance.getEntriesByName(WASM_URL.href).at(-1);
    postMessage({ t: 'wasm-ready', bytes: got, ms: Math.round(performance.now() - started), cached: entry ? entry.transferSize === 0 : undefined });
  })();
  return wasmReady;
}

const waiting = new Map();
const bus = new BroadcastChannel('tandem-media');

// ---------- Storage: one Station at a time per film file ----------
//
// A film lives in OPFS files that only one sync access handle may hold at a
// time (Chrome's 'readwrite-unsafe' mode lets several share them). A reload, a
// leave and rejoin, or a second tab all reach the same files, so each copy of
// the film has a Web Lock, and the Station holding it answers on a channel. A
// new Station that finds the lock held asks who has it: a live Station in
// another tab is left alone, and this one shares the files (Chrome) or keeps
// its own copy; a holder that does not answer is a Station shutting down, so
// this one waits for it, and takes the lock if it never lets go.

/** This Station, for the Service Worker's reads and the owners' channel. */
const sid = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
// Copies of one film at most: the first, then one per tab that cannot share it.
const SLOTS = 4;
const ASK_MS = 600;
const RELEASE_WAIT_MS = 4000;
const HANDLE_WAIT_MS = 3000;
const owners = new BroadcastChannel('tandem-owners');
/** Copies this Station has claimed, by lock name, whether open yet or not. */
const claimed = new Set();
owners.onmessage = ({ data }) => {
  if (data.t === 'who' && claimed.has(data.lock)) owners.postMessage({ t: 'here', rid: data.rid, lock: data.lock, sid });
};

/** Whether a live Station holds this lock: it answers within ASK_MS. */
function liveHolder(lock) {
  const rid = crypto.randomUUID();
  return new Promise((done) => {
    const ch = new BroadcastChannel('tandem-owners');
    const timer = setTimeout(() => { ch.close(); done(null); }, ASK_MS);
    ch.onmessage = ({ data }) => {
      if (data.t === 'here' && data.rid === rid) { clearTimeout(timer); ch.close(); done(data.sid); }
    };
    ch.postMessage({ t: 'who', rid, lock });
  });
}

/**
 * Takes a Web Lock and keeps it until `release()`. Resolves to null when it is
 * not given: busy with `ifAvailable`, or not free before `signal` aborts.
 */
function takeLock(name, opts = {}) {
  return new Promise((resolve, reject) => {
    let release;
    let handle = null;
    const held = new Promise((r) => { release = r; });
    navigator.locks.request(name, opts, (lock) => {
      if (!lock) { resolve(null); return undefined; }
      handle = { name, release, lost: false };
      resolve(handle);
      return held;
    }).catch((e) => {
      // Aborted while waiting, or later taken from us with `steal`.
      if (handle) handle.lost = true;
      if (e.name === 'AbortError') resolve(null);
      else reject(e);
    });
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const filmName = (root, slot) => `film-${root.slice(0, 40)}${slot > 1 ? `-${slot}` : ''}`;

/** A copy of the film: a Storage Bucket where the browser has them, else plain OPFS. */
async function openDirectory(root, slot) {
  const name = filmName(root, slot);
  if (navigator.storageBuckets && !options.noBuckets) {
    const bucket = await navigator.storageBuckets.open(name, { persisted: true, durability: 'strict' });
    return { bucket, dir: await bucket.getDirectory(), kind: 'bucket', name };
  }
  if (!navigator.storage?.getDirectory) throw Object.assign(new Error('this browser has no private file storage'), { name: 'SecurityError' });
  const top = await navigator.storage.getDirectory();
  return { bucket: null, dir: await top.getDirectoryHandle(name, { create: true }), kind: 'opfs', name };
}

/**
 * Whether this browser lets several Stations hold a file at once, with
 * `createSyncAccessHandle({ mode: 'readwrite-unsafe' })`. A browser that
 * ignores the mode gives an exclusive handle, so the probe opens two.
 */
let sharing = null;
async function canShare(dir) {
  if (sharing !== null) return sharing;
  if (options.noShare) return (sharing = false);
  const file = await dir.getFileHandle('probe.bin', { create: true });
  let a = null;
  let b = null;
  try {
    a = await file.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
    b = await file.createSyncAccessHandle({ mode: 'readwrite-unsafe' });
    sharing = true;
  } catch {
    sharing = false;
  } finally {
    a?.close();
    b?.close();
  }
  return sharing;
}

/**
 * The three files of one copy. A Station that has just let go may still hold
 * a file for a moment, so a busy file is tried again for a while.
 */
async function openFiles(dir, shared) {
  const mode = shared ? { mode: 'readwrite-unsafe' } : undefined;
  const files = {};
  try {
    for (const name of ['film', 'have', 'manifest']) {
      const file = await dir.getFileHandle(`${name}.bin`, { create: true });
      for (let waited = 0, step = 50; ; waited += step, step = Math.min(step * 2, 500)) {
        try {
          files[name] = await file.createSyncAccessHandle(mode);
          break;
        } catch (e) {
          if (e.name !== 'NoModificationAllowedError' || waited >= HANDLE_WAIT_MS) throw e;
          await pause(step);
        }
      }
    }
    return files;
  } catch (e) {
    for (const h of Object.values(files)) try { h.close(); } catch { /* already closed */ }
    throw e;
  }
}

/**
 * Claims a copy of the film for this Station: its lock, its directory and its
 * open files. Says how it got them, for the page.
 */
async function claimFilm(root) {
  let last = null;
  let crowded = false;
  for (let slot = 1; slot <= SLOTS; slot++) {
    const where = await openDirectory(root, slot);
    const shared = await canShare(where.dir);
    const lockName = `tandem-film:${where.kind}:${where.name}`;
    let lock = await takeLock(lockName, { ifAvailable: true });
    let sharer = false;
    if (!lock) {
      const holder = await liveHolder(lockName);
      if (holder && shared) sharer = true;
      else if (holder) { crowded = true; continue; }
      else {
        // No answer: a Station shutting down, after a reload or a leave. Wait for
        // it, then take the lock: a Station that does not answer is gone.
        postMessage({ t: 'storage-wait', slot });
        lock = await takeLock(lockName, { signal: AbortSignal.timeout(RELEASE_WAIT_MS) });
        lock ??= await takeLock(lockName, { steal: true });
      }
    }
    if (lock) claimed.add(lockName);
    try {
      const files = await openFiles(where.dir, shared);
      return { ...where, files, lock, lockName, slot, shared, sharer, crowded: crowded || sharer };
    } catch (e) {
      claimed.delete(lockName);
      lock?.release();
      last = e;
      // Held by a Station this one could not see: try the next copy.
      if (e.name === 'NoModificationAllowedError') { crowded = true; continue; }
      throw e;
    }
  }
  throw last ?? Object.assign(new Error('every copy of this film is in use in other tabs'), { name: 'NoModificationAllowedError' });
}

/** Removes extra copies no Station holds, once the first copy is ours. */
async function dropSpareCopies(root, kind) {
  for (let slot = 2; slot <= SLOTS; slot++) {
    const name = filmName(root, slot);
    const lock = await takeLock(`tandem-film:${kind}:${name}`, { ifAvailable: true }).catch(() => null);
    if (!lock) continue;
    try {
      if (kind === 'bucket') {
        if ((await navigator.storageBuckets.keys()).includes(name)) await navigator.storageBuckets.delete(name);
      } else {
        await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true }).catch((e) => { if (e.name !== 'NotFoundError') throw e; });
      }
    } catch { /* in use, or gone already */ } finally {
      lock.release();
    }
  }
}

/**
 * The film's chunks as plain files over HTTPS, when config.json names a mirror
 * for this exact film (`screening.mirror`), or `mirror=<base URL>` is in the
 * address for a test. Its manifest must add up to the room's root, and the
 * Station checks every chunk too, so a wrong or tampered mirror costs only time.
 *
 * `base` may be a list of hosts with the same files. A browser sends every
 * request to one host over one HTTP/2 connection, and some links limit each
 * connection, so the chunks are spread over the hosts.
 */
async function findMirror(root) {
  let spec = null;
  if (options.noMirror) return null;
  try {
    if (options.mirror) spec = { root, base: options.mirror };
    else {
      const res = await fetch(new URL('../config.json', import.meta.url), { cache: 'no-cache' });
      const screening = (await res.json()).screening ?? {};
      // A list of mirrors, one per film, keyed by root; `mirror` is the older single one.
      const all = [...(screening.mirrors ?? []), ...(screening.mirror ? [screening.mirror] : [])];
      spec = all.find((m) => m.root === root) ?? null;
    }
    if (!spec?.base || spec.root !== root) return null;
    const hosts = [spec.base].flat().map((b) => ({ base: new URL(b, import.meta.url), busy: 0, restUntil: 0, bytes: 0, fails: 0 }));
    const base = hosts[0].base;
    const res = await fetch(new URL(spec.manifest ?? 'manifest.json', base), { signal: AbortSignal.timeout(MIRROR_PATIENCE_MS * 2) });
    if (!res.ok) throw new Error(`manifest: HTTP ${res.status}`);
    const m = await res.json();
    const manifest = new Uint8Array(8 + 32 * m.chunks.length);
    new DataView(manifest.buffer).setBigUint64(0, BigInt(m.size), true);
    m.chunks.forEach((hex, i) => {
      for (let b = 0; b < 32; b++) manifest[8 + i * 32 + b] = parseInt(hex.substr(b * 2, 2), 16);
    });
    if (manifest_root(manifest) !== root) throw new Error('its manifest is for another film');
    const pattern = m.chunk_name ?? 'c{index:05}.bin';
    const name = (i) => pattern.replace(/\{index(?::0(\d+))?\}/, (_, w) => String(i).padStart(Number(w ?? 0), '0'));
    return { base, hosts, manifest, name };
  } catch (e) {
    postMessage({ t: 'mirror-off', why: String(e.message ?? e) });
    return null;
  }
}

class Store {
  constructor(claim, size) {
    Object.assign(this, { claim, data: claim.files.film, have: claim.files.have, size, kind: claim.kind, bucket: claim.bucket, closed: false });
  }

  /** Lets go of the files and the lock, so another Station can have them. */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const h of Object.values(this.claim.files)) {
      try { h.flush(); } catch { /* closed, or read-only */ }
      try { h.close(); } catch { /* already closed */ }
    }
    claimed.delete(this.claim.lockName);
    this.claim.lock?.release();
  }

  /**
   * Called by the wasm for a chunk from the mirror; the wasm checks the bytes.
   * A chunk a read waits on goes first: to the least busy host, at high priority.
   */
  async mirror(index) {
    if (this.closed) throw new Error('the film is closed');
    const now = Date.now();
    const urgent = waiting.has(index) || !this.holds(0);
    const ready = this.source.hosts.filter((h) => h.restUntil <= now);
    const host = (ready.length ? ready : this.source.hosts).reduce((a, b) => (b.busy < a.busy ? b : a));
    const stop = new AbortController();
    let timer = setTimeout(() => stop.abort(new Error('mirror: no bytes for a while')), MIRROR_PATIENCE_MS);
    host.busy++;
    try {
      const res = await fetch(new URL(this.source.name(index), host.base), { signal: stop.signal, priority: urgent ? 'high' : 'low' });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${host.base.host}`);
      const out = new Uint8Array(Math.min(CHUNK, this.size - index * CHUNK));
      const reader = res.body.getReader();
      let at = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (at + value.length > out.length) throw new Error(`chunk ${index} is too long`);
        out.set(value, at);
        at += value.length;
        clearTimeout(timer);
        timer = setTimeout(() => stop.abort(new Error('mirror: no bytes for a while')), MIRROR_PATIENCE_MS);
      }
      host.bytes += at;
      host.fails = 0;
      return out.subarray(0, at);
    } catch (e) {
      host.fails++;
      host.restUntil = Date.now() + MIRROR_REST_MS;
      throw e;
    } finally {
      clearTimeout(timer);
      host.busy--;
    }
  }

  /** Called by the wasm with a chunk that has passed its hash. */
  saved(index, bytes) {
    if (this.closed) throw new Error('the film is closed');
    try {
      this.data.write(bytes, { at: index * CHUNK });
      this.data.flush();
      this.have.write(new Uint8Array([1]), { at: index });
      this.have.flush();
    } catch (e) {
      // A full disk shows only here, mid-film: tell the page once.
      if (e.name === 'QuotaExceededError' && !this.full) {
        this.full = true;
        postMessage({ t: 'error', kind: 'storage', name: e.name, text: `storage: ${e.name} ${e.message}` });
      }
      throw e;
    }
    for (const job of waiting.get(index) ?? []) answer(job);
    waiting.delete(index);
  }

  holds(index) {
    if (this.closed) return false;
    const b = new Uint8Array(1);
    this.have.read(b, { at: index });
    return b[0] === 1;
  }

  read(start, end) {
    const out = new Uint8Array(end - start + 1);
    this.data.read(out, { at: start });
    return out;
  }
}

/** Finds the film's bytes on disk, or asks the room for them. */
async function openFilm(id, root, generation) {
  const started = performance.now();
  const claim = await claimFilm(root);
  // Everything after this point lets go of the files if it fails, or if the
  // room has moved on while it ran.
  const owned = new Store(claim, 0);
  try {
    const stale = () => generation !== filmGeneration;
    const { film: data, have, manifest: manifestFile } = claim.files;
    let manifest = new Uint8Array(manifestFile.getSize());
    manifestFile.read(manifest, { at: 0 });
    const fromDisk = manifest.length > 8;
    const source = await findMirror(root);
    if (!fromDisk) {
      // The mirror's manifest has passed the root check, and saves a trip over the relay.
      manifest = source?.manifest ?? await station.manifest(root);
      if (stale()) throw Object.assign(new Error('the room moved on'), { name: 'AbortError' });
      manifestFile.write(manifest, { at: 0 });
      manifestFile.flush();
    }
    const size = Number(new DataView(manifest.buffer, manifest.byteOffset).getBigUint64(0, true));
    const count = (manifest.length - 8) / 32;
    if (data.getSize() !== size) data.truncate(size);
    if (have.getSize() !== count) have.truncate(count);

    // Trust nothing on disk: each kept chunk is checked again. A Station that
    // shares the files with another leaves the marks to their owner.
    const bits = new Uint8Array(count);
    have.read(bits, { at: 0 });
    // For tests: forget chunks, so a seek can miss without a fresh download.
    for (const i of options.forget ?? []) {
      bits[i] = 0;
      have.write(new Uint8Array([0]), { at: i });
    }
    let kept = 0;
    const buf = new Uint8Array(CHUNK);
    for (let i = 0; i < count; i++) {
      if (bits[i] !== 1) continue;
      const len = Math.min(CHUNK, size - i * CHUNK);
      const got = buf.subarray(0, len);
      data.read(got, { at: i * CHUNK });
      if (chunk_ok(manifest, i, got)) kept++;
      else {
        bits[i] = 0;
        if (!claim.sharer) have.write(new Uint8Array([0]), { at: i });
      }
      // Let the owners' channel answer: a Station waiting on this copy must
      // not take a busy one for a dead one.
      if (i % 16 === 15) await pause(0);
      if (stale()) throw Object.assign(new Error('the room moved on'), { name: 'AbortError' });
    }
    have.flush();
    owned.size = size;
    store = owned;
    store.id = id;
    store.root = root;
    store.count = count;
    store.source = source;
    leadMs = source ? MIRROR_LEAD_MS : LEAD_MS;
    station.open_film(id, root, manifest, bits, options.window ?? 0, store, source ? MIRROR_FETCHES : 0);
    // In the same turn, before the download's first pick: the header first (a
    // browser reads it before anything), and the chunk at the room's position
    // next, so a joiner fetches both at once.
    if (station.want) {
      station.want(0);
      // Aim at the room's position only for the item it plays now.
      const ms = lastView?.state.timeline.item === id ? lastView.state.items.find((i) => i.id === id)?.duration_ms : null;
      if (ms) station.steer(aim(lastView.position_us / 1000, ms, count));
    }
    const how = claim.sharer ? 'shared' : claim.slot > 1 ? 'own-copy' : 'owner';
    postMessage({ t: 'film', id, sid, size, count, kept, kind: claim.kind, how, slot: claim.slot, shared: claim.shared, manifestFromDisk: fromDisk, mirror: source?.base.href ?? null, verifyMs: performance.now() - started, storage: await storageFacts(claim.bucket) });
    for (const job of pendingReads.splice(0)) serve(job);
    if (claim.slot === 1 && !claim.sharer) dropSpareCopies(root, claim.kind).catch(() => {});
  } catch (e) {
    if (store === owned) store = null;
    owned.close();
    throw e;
  }
}

/**
 * Stops the download and lets go of the film's files and lock: on leaving, when
 * the room moves to another film or ends, and after an error.
 */
function closeFilm() {
  filmGeneration++;
  try { station?.close_film?.(); } catch { /* an older Station */ }
  store?.close();
  store = null;
  opening = null;
  // Reads in the Service Worker would wait minutes for an answer, and a browser
  // can hold back the next page while they do: end them now.
  for (const jobs of waiting.values()) for (const job of jobs) bus.postMessage({ t: 'gone', rid: job.rid });
  for (const job of pendingReads.splice(0)) bus.postMessage({ t: 'gone', rid: job.rid });
  waiting.clear();
}

async function storageFacts(bucket) {
  const facts = { storagePersisted: await navigator.storage.persisted?.(), estimate: await navigator.storage.estimate() };
  if (bucket) {
    facts.bucket = {
      name: bucket.name,
      methods: Object.keys(Object.getPrototypeOf(bucket)),
      // Chrome has moved between a method and a plain attribute here.
      persisted: await (typeof bucket.persisted === 'function' ? bucket.persisted() : bucket.persisted),
      durability: await (typeof bucket.durability === 'function' ? bucket.durability() : bucket.durability),
      estimate: await bucket.estimate?.(),
    };
  }
  return facts;
}

const pendingReads = [];

// Where the room will be when a first chunk arrives: two 4 MB chunks at a
// relay's measured 0.4 MB/s take about 20 s, from a mirror a second or two.
// The download picks from one chunk before the cursor, hence the + 1.
const LEAD_MS = 20_000;
const MIRROR_LEAD_MS = 3_000;
let leadMs = LEAD_MS;
const aim = (posMs, durMs, count) => Math.min(count - 1, Math.floor(((posMs + leadMs) / durMs) * count) + 1);
let lastView = null;

// A format this browser cannot play: a native Station converts it on the fly.
let liveGeneration = 0;
let liveRoot = null;
let liveAck = null;
let liveBytes = 0;

function startLive(start, width) {
  const generation = ++liveGeneration;
  liveAck?.();
  station.live(liveRoot, start * 1000, width, (bytes) => {
    if (generation !== liveGeneration) throw new Error('replaced');
    liveBytes += bytes.length;
    postMessage({ t: 'live-bytes', generation, bytes, total: liveBytes }, [bytes.buffer]);
    return new Promise((ok) => { liveAck = ok; });
  }).then(() => {
    if (generation === liveGeneration) postMessage({ t: 'live-end', generation });
  }).catch((e) => {
    if (generation === liveGeneration) postMessage({ t: 'error', text: `live: ${e.message ?? e}` });
  });
  return generation;
}

function answer(job) {
  bus.postMessage({ t: 'bytes', rid: job.rid, start: job.start, total: store.size, bytes: store.read(job.start, job.end) });
}

/** One read from the Service Worker, as much as the chunk under it allows. */
function serve({ rid, id, start, end }) {
  if (!store || store.id !== id) {
    pendingReads.push({ rid, id, start, end });
    return;
  }
  if (start >= store.size) {
    bus.postMessage({ t: 'range', rid, total: store.size });
    return;
  }
  const index = Math.floor(start / CHUNK);
  const boundary = (index + 1) * CHUNK - 1;
  const last = Math.min(end ?? Infinity, boundary, start + SLICE - 1, store.size - 1);
  const job = { rid, start, end: last };
  if (store.holds(index)) answer(job);
  else {
    if (!waiting.has(index)) waiting.set(index, []);
    waiting.get(index).push(job);
    postMessage({ t: 'miss', index });
    // Older builds of the Station have no want(); they reach the chunk in turn.
    station.want?.(index);
  }
}

// Every tab's Station hears every read, so a read names the Station it is for.
bus.onmessage = (e) => {
  if (e.data.t !== 'read' || (e.data.s && e.data.s !== sid)) return;
  if (!leaving) serve(e.data);
  else if (e.data.s) bus.postMessage({ t: 'gone', rid: e.data.rid });
};

function publish() {
  const view = JSON.parse(station.view());
  // A page holding a seat for the next item downloads that one instead.
  const id = wantItem && view.state.items.some((i) => i.id === wantItem) ? wantItem : view.state.timeline.item;
  const item = view.state.items.find((i) => i.id === id);
  const root = item?.source.File?.root;
  // The room moved to another film, or has none now: let this one go.
  if (openRoot && openRoot !== root && !leaving) {
    closeFilm();
    openRoot = null;
  }
  if (leaving || Date.now() < retryAt) {
    // Nothing new opens while leaving, or soon after a failure.
  } else if (root && !opening && (options.small || /\.(mkv|avi|wmv|flv|mpg|mpeg|ts)$/i.test(item.name))) {
    opening = Promise.resolve();
    openRoot = root;
    liveRoot = root;
    postMessage({ t: 'live-film', id, position: view.position_us / 1e6, duration: (item.duration_ms ?? 0) / 1000 });
  } else if (root && !opening) {
    const generation = ++filmGeneration;
    openRoot = root;
    opening = openFilm(id, root, generation).catch((e) => {
      if (generation !== filmGeneration) return;
      opening = null;
      openRoot = null;
      retryAt = Date.now() + 5000;
      postMessage({ t: 'error', kind: 'storage', name: e.name ?? '', text: `storage: ${e.name ?? ''} ${e.message ?? e}` });
    });
  }
  lastView = view;
  const hosts = store?.source?.hosts.map((h) => ({ host: h.base.host, bytes: h.bytes, busy: h.busy, fails: h.fails }));
  postMessage({ t: 'view', view, links: JSON.parse(station.links()), film: JSON.parse(station.film_stats()), hosts });
}

onmessage = async ({ data }) => {
  switch (data.t) {
    case 'warm': loadWasm().catch(() => {}); break;
    case 'join':
      options = data;
      try {
        await loadWasm();
        station = await Tandem.join(data.invite, data.name, data.key, data.windowKb);
        // A Station built before the viewer list has no such call; it is then never named.
        if (data.listed === false) station.set_listed?.(false);
        // Renamed while the Station was still joining.
        if (renamed && renamed !== data.name) station.set_name?.(renamed);
        if (listedLater != null && listedLater !== data.listed) station.set_listed?.(listedLater);
        postMessage({ t: 'joined', me: station.me(), inWorker: typeof document === 'undefined' });
        setInterval(publish, 500);
        // How late this Worker's own timer fires: a busy Worker delays the room too.
        let due = performance.now() + TICK_MS;
        let lag = 0;
        setInterval(() => {
          const now = performance.now();
          lag = Math.max(lag, now - due);
          due = now + TICK_MS;
          postMessage({ t: 'tick' });
        }, TICK_MS);
        setInterval(() => { postMessage({ t: 'lag', ms: Math.round(lag) }); lag = 0; }, 2000);
      } catch (e) {
        postMessage({ t: 'error', text: e.message ?? String(e) });
      }
      break;
    case 'sample': {
      if (!station) return;
      // Where the player is now, not when it was sampled: this Worker may have
      // been busy (hashing chunks, a slow call) while the report waited, and
      // steering against an old position reads the wait as lag.
      const wall = performance.timeOrigin + performance.now();
      const age = data.at ? Math.min(1, Math.max(0, (wall - data.at) / 1000)) : 0;
      const moving = data.playing && !data.seeking && !data.buffering;
      const pos = moving ? data.pos + age * (data.speed > 0 ? data.speed : data.rate ?? 1) : data.pos;
      const d = station.player(pos, data.playing, data.buffering, data.seeking, data.speed);
      if (store && data.duration) station.steer(Math.floor((data.pos / data.duration) * store.count));
      else if (store && lastView) {
        // Before the picture knows its length, aim at the room's position from
        // the room's own figures, so that chunk comes alongside the header.
        const item = lastView.state.items.find((i) => i.id === store.id);
        const ms = item?.duration_ms;
        if (ms) station.steer(aim(lastView.position_us / 1000, ms, store.count));
      }
      postMessage({ t: 'directive', d: { ...JSON.parse(d), at: wall } });
      break;
    }
    case 'live-go': postMessage({ t: 'live-started', generation: startLive(data.start, data.width), want: data.want }); break;
    case 'live-more': liveAck?.(); break;
    // A held seat downloads from the top, where the next showing starts.
    case 'steer': if (store) station?.steer(data.chunk); break;
    case 'want-item': wantItem = data.id ?? null; break;
    case 'storage': postMessage({ t: 'storage', facts: await storageFacts(store?.bucket) }); break;
    case 'gone': station?.player_gone(); break;
    case 'chat': station?.chat(data.text); break;
    case 'listed': listedLater = data.on; station?.set_listed?.(data.on); break;
    case 'name': renamed = data.name; station?.set_name?.(data.name); break;
    case 'bye':
      // The page is going: let go of the film first, so the next Station (a
      // reload, a rejoin, another tab) finds it free at once.
      leaving = true;
      closeFilm();
      owners.close();
      try { station?.bye(); } catch { /* not joined */ }
      postMessage({ t: 'closed' });
      break;
    case 'close-film': closeFilm(); openRoot = null; break;
    default: break;
  }
};

postMessage({ t: 'ready' });
