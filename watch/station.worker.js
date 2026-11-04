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

// The wasm is the biggest thing the page loads, so it starts at once, with
// progress for the page. The copy that streams into the compiler is the
// browser's own response, so the browser can keep the compiled code for the
// next visit; a clone of it is only counted.
const WASM_URL = new URL('./pkg/tandem_web_bg.wasm', import.meta.url);
// The wasm's size, for progress where the server compresses it (GitHub Pages
// does) and so sends no usable length. Update it with pkg/; it only steers a bar.
const WASM_BYTES = 3_173_589;
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

/** Opens a film's own storage: a bucket when the browser has them, else OPFS. */
async function openDirectory(root) {
  const name = `film-${root.slice(0, 40)}`;
  if (navigator.storageBuckets && !options.noBuckets) {
    const bucket = await navigator.storageBuckets.open(name, { persisted: true, durability: 'strict' });
    return { bucket, dir: await bucket.getDirectory(), kind: 'bucket' };
  }
  const top = await navigator.storage.getDirectory();
  return { bucket: null, dir: await top.getDirectoryHandle(name, { create: true }), kind: 'opfs' };
}

/** A reload can reach a file before the old Worker's lock has gone. */
async function syncHandle(dir, name) {
  const file = await dir.getFileHandle(name, { create: true });
  for (let tries = 40; ; tries--) {
    try {
      return await file.createSyncAccessHandle();
    } catch (e) {
      if (tries === 0 || e.name !== 'NoModificationAllowedError') throw e;
      await new Promise((r) => setTimeout(r, 100));
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
      spec = (await res.json()).screening?.mirror ?? null;
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
  constructor(data, have, size, kind, bucket) {
    Object.assign(this, { data, have, size, kind, bucket });
  }

  /**
   * Called by the wasm for a chunk from the mirror; the wasm checks the bytes.
   * A chunk a read waits on goes first: to the least busy host, at high priority.
   */
  async mirror(index) {
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
    this.data.write(bytes, { at: index * CHUNK });
    this.data.flush();
    this.have.write(new Uint8Array([1]), { at: index });
    this.have.flush();
    for (const job of waiting.get(index) ?? []) answer(job);
    waiting.delete(index);
  }

  holds(index) {
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
async function openFilm(id, root) {
  const { dir, kind, bucket } = await openDirectory(root);
  const started = performance.now();
  const data = await syncHandle(dir, 'film.bin');
  const have = await syncHandle(dir, 'have.bin');
  const manifestFile = await syncHandle(dir, 'manifest.bin');
  let manifest = new Uint8Array(manifestFile.getSize());
  manifestFile.read(manifest, { at: 0 });
  const fromDisk = manifest.length > 8;
  const source = await findMirror(root);
  if (!fromDisk) {
    // The mirror's manifest has passed the root check, and saves a trip over the relay.
    manifest = source?.manifest ?? await station.manifest(root);
    manifestFile.write(manifest, { at: 0 });
    manifestFile.flush();
  }
  manifestFile.close();
  const size = Number(new DataView(manifest.buffer, manifest.byteOffset).getBigUint64(0, true));
  const count = (manifest.length - 8) / 32;
  if (data.getSize() !== size) data.truncate(size);
  if (have.getSize() !== count) have.truncate(count);

  // Trust nothing on disk: each kept chunk is checked again.
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
      have.write(new Uint8Array([0]), { at: i });
    }
  }
  have.flush();
  store = new Store(data, have, size, kind, bucket);
  store.id = id;
  store.count = count;
  store.source = source;
  leadMs = source ? MIRROR_LEAD_MS : LEAD_MS;
  station.open_film(id, root, manifest, bits, options.window ?? 0, store, source ? MIRROR_FETCHES : 0);
  // In the same turn, before the download's first pick: the header first (a
  // browser reads it before anything), and the chunk at the room's position
  // next, so a joiner fetches both at once.
  if (station.want) {
    station.want(0);
    const ms = lastView?.state.items.find((i) => i.id === id)?.duration_ms;
    if (ms) station.steer(aim(lastView.position_us / 1000, ms, count));
  }
  postMessage({ t: 'film', id, size, count, kept, kind, manifestFromDisk: fromDisk, mirror: source?.base.href ?? null, verifyMs: performance.now() - started, storage: await storageFacts(bucket) });
  for (const job of pendingReads.splice(0)) serve(job);
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

bus.onmessage = (e) => {
  if (e.data.t === 'read') serve(e.data);
};

function publish() {
  const view = JSON.parse(station.view());
  const id = view.state.timeline.item;
  const item = view.state.items.find((i) => i.id === id);
  const root = item?.source.File?.root;
  if (root && !opening && (options.small || /\.(mkv|avi|wmv|flv|mpg|mpeg|ts)$/i.test(item.name))) {
    opening = Promise.resolve();
    liveRoot = root;
    postMessage({ t: 'live-film', id, position: view.position_us / 1e6, duration: (item.duration_ms ?? 0) / 1000 });
  } else if (root && !opening) {
    opening = openFilm(id, root).catch((e) => {
      opening = null;
      postMessage({ t: 'error', text: `storage: ${e.name ?? ''} ${e.message ?? e}` });
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
      const d = station.player(data.pos, data.playing, data.buffering, data.seeking, data.speed);
      if (store && data.duration) station.steer(Math.floor((data.pos / data.duration) * store.count));
      else if (store && lastView) {
        // Before the picture knows its length, aim at the room's position from
        // the room's own figures, so that chunk comes alongside the header.
        const item = lastView.state.items.find((i) => i.id === store.id);
        const ms = item?.duration_ms;
        if (ms) station.steer(aim(lastView.position_us / 1000, ms, store.count));
      }
      postMessage({ t: 'directive', d: JSON.parse(d) });
      break;
    }
    case 'live-go': postMessage({ t: 'live-started', generation: startLive(data.start, data.width), want: data.want }); break;
    case 'live-more': liveAck?.(); break;
    case 'storage': postMessage({ t: 'storage', facts: await storageFacts(store?.bucket) }); break;
    case 'gone': station?.player_gone(); break;
    case 'chat': station?.chat(data.text); break;
    case 'bye': station?.bye(); break;
    default: break;
  }
};

postMessage({ t: 'ready' });
