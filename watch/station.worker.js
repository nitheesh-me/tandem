// The Station. Networking, Room and swarm run here, and so does storage, because
// OPFS sync access handles exist only in a dedicated Worker. It also sets the
// pace for the page: a Worker's timers keep running in a hidden tab.
import init, { Tandem, chunk_ok } from './pkg/tandem_web.js';

const CHUNK = 4 * 1024 * 1024;
const SLICE = 2 * 1024 * 1024;
const TICK_MS = 200;

let station = null;
let store = null;
let opening = null;
let options = {};
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

class Store {
  constructor(data, have, size, kind, bucket) {
    Object.assign(this, { data, have, size, kind, bucket });
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
  if (!fromDisk) {
    manifest = await station.manifest(root);
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
  station.open_film(id, root, manifest, bits, options.window ?? 0, store);
  postMessage({ t: 'film', id, size, count, kept, kind, manifestFromDisk: fromDisk, verifyMs: performance.now() - started, storage: await storageFacts(bucket) });
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
  if (root && !opening && /\.(mkv|avi|wmv|flv|mpg|mpeg|ts)$/i.test(item.name)) {
    opening = Promise.resolve();
    liveRoot = root;
    postMessage({ t: 'live-film', id, position: view.position_us / 1e6, duration: (item.duration_ms ?? 0) / 1000 });
  } else if (root && !opening) {
    opening = openFilm(id, root).catch((e) => {
      opening = null;
      postMessage({ t: 'error', text: `storage: ${e.name ?? ''} ${e.message ?? e}` });
    });
  }
  postMessage({ t: 'view', view, links: JSON.parse(station.links()), film: JSON.parse(station.film_stats()) });
}

onmessage = async ({ data }) => {
  switch (data.t) {
    case 'join':
      options = data;
      try {
        await init();
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
