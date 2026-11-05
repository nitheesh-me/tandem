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

function ask(id, s, start, end) {
  const rid = crypto.randomUUID();
  return new Promise((resolve) => {
    replies.set(rid, resolve);
    bus.postMessage({ t: 'read', rid, id, s, start, end });
    setTimeout(() => {
      if (replies.delete(rid)) resolve({ t: 'late' });
    }, PATIENCE_MS);
  });
}

async function media(request, id) {
  // The Station the page names: every tab's Station hears this channel.
  const url = new URL(request.url);
  const s = url.searchParams.get('s') ?? undefined;
  // The page names the file's type (a song is not an MP4); some browsers trust it over the bytes.
  const asked = url.searchParams.get('type') ?? '';
  const type = /^(audio|video)\/[a-z0-9.+-]{1,40}$/.test(asked) ? asked : 'video/mp4';
  const m = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') ?? 'bytes=0-');
  if (!m) return new Response(null, { status: 416 });
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : undefined;
  const got = await ask(id, s, start, end);
  if (got.t === 'late') return new Response(null, { status: 504 });
  // The Station left: its page is going away.
  if (got.t === 'gone') return new Response(null, { status: 503 });
  if (got.t === 'range') return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${got.total}` } });
  const last = start + got.bytes.length - 1;
  served++;
  return new Response(got.bytes, {
    status: 206,
    headers: {
      'Content-Type': type,
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
self.addEventListener('message', (e) => {
  // A page that opened without this worker in charge asks to be taken over.
  if (e.data?.t === 'claim') e.waitUntil(self.clients.claim());
  else e.source?.postMessage({ t: 'sw', started, served });
});
