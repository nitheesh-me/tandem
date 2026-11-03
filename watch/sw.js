// A thin proxy. It holds no film and no state worth keeping: `/media/<id>` reads
// become one message to the Station Worker, so being killed loses nothing.
// A BroadcastChannel needs no handshake, so a restarted worker just works.
const bus = new BroadcastChannel('tandem-media');
const replies = new Map();
const PATIENCE_MS = 120_000;
const started = Date.now();
let served = 0;

bus.onmessage = ({ data }) => {
  const done = replies.get(data.rid);
  if (done) {
    replies.delete(data.rid);
    done(data);
  }
};

function ask(id, start, end) {
  const rid = crypto.randomUUID();
  return new Promise((resolve) => {
    replies.set(rid, resolve);
    bus.postMessage({ t: 'read', rid, id, start, end });
    setTimeout(() => {
      if (replies.delete(rid)) resolve({ t: 'late' });
    }, PATIENCE_MS);
  });
}

async function media(request, id) {
  const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') ?? 'bytes=0-');
  if (!m) return new Response(null, { status: 416 });
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  const got = await ask(id, start, end);
  if (got.t === 'late') return new Response(null, { status: 504 });
  if (got.t === 'range') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${got.total}` } });
  const last = start + got.bytes.length - 1;
  served++;
  return new Response(got.bytes, {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(got.bytes.length),
      'Content-Range': `bytes ${start}-${last}/${got.total}`,
      'Cache-Control': 'no-store',
    },
  });
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const m = /\/media\/([0-9a-f]+)$/.exec(new URL(e.request.url).pathname);
  if (m) e.respondWith(media(e.request, m[1]));
});
// For the test: this proves a kill really produced a new instance.
self.addEventListener('message', (e) => e.source?.postMessage({ t: 'sw', started, served }));
