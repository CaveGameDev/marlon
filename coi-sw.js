'use strict';
// Two things a plain static host usually gets wrong for this game, both fixable from
// inside the page by a service worker:
//   1. it cannot send Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy, so the
//      page is not cross-origin isolated and WebAssembly shared memory is unavailable;
//   2. simple file servers ignore byte-range requests, so a disc read comes back as the
//      whole file with 200 instead of the 256 KiB slice it asked for (the game then
//      cannot read main.dol and stops).
// The worker adds the isolation headers, and when a host answers a range request with the
// full body it keeps one copy of that file and serves proper 206 slices from it.
const ISO = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
const BYTES = 'nsmbw-bytes-v1';
const MAX_CACHED = 32 << 20;      // don't keep files bigger than this in Cache Storage

// Let an updated worker wait until existing tabs close. Forcing activation while a large
// WASM download is streaming can abort that response mid-flight.
self.addEventListener('install', () => {});
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.clients.claim();
  for (const name of await caches.keys()) {
    if (name.startsWith('nsmbw-bytes-') && name !== BYTES) await caches.delete(name);
  }
})()));

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(serve(request, url));
});

const freshRe = /\.(?:html?|js|css|json|png|jpe?g|webp)$/i;

async function serve(request, url) {
  // Revalidate lightweight site files after a deployment (GitHub Pages otherwise caches
  // index.html, scripts and menu images for 10 minutes); keep the large WASM download cached.
  const fresh = request.mode === 'navigate' || freshRe.test(url.pathname);
  const range = request.headers.get('Range');
  if (!range) return decorate(await fetch(request, fresh ? { cache: 'no-store' } : undefined), fresh);

  const kept = await keptBody(url);
  if (kept) return slice(kept.body, range, kept.type);

  const response = await fetch(request);
  if (response.status !== 200) return decorate(response, false);   // 206: the host already slices
  const body = await response.arrayBuffer();
  const type = response.headers.get('Content-Type') || 'application/octet-stream';
  await keepBody(url, body, type, response);
  return slice(body, range, type);
}

// Objects stored as <file url>?nsmbw-range=<length>-<modified>-<etag>, so a redeploy
// (which changes those headers) simply misses the old copy instead of serving it.
async function keptBody(url) {
  try {
    const cache = await caches.open(BYTES);
    for (const key of await cache.keys()) {
      if (!key.url.startsWith(url.href + '?')) continue;
      const hit = await cache.match(key);
      if (hit) return { body: await hit.arrayBuffer(), type: hit.headers.get('Content-Type') };
    }
  } catch (e) { /* no Cache Storage: fall back to the network */ }
  return null;
}

async function keepBody(url, body, type, response) {
  if (body.byteLength > MAX_CACHED) return;
  const tag = ['Content-Length', 'Last-Modified', 'ETag']
    .map((h) => response.headers.get(h)).filter(Boolean).join('-') || 'v';
  try {
    const cache = await caches.open(BYTES);
    await cache.put(
      new Request(url.href + '?nsmbw-range=' + encodeURIComponent(tag)),
      new Response(body, { headers: { 'Content-Type': type } }),
    );
  } catch (e) { /* quota or private mode: the slice below is still correct */ }
}

function slice(body, rangeHeader, type) {
  const size = body.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '') || [];
  let start, end;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2] || 0)); end = size - 1; }   // "bytes=-N": last N
  else { start = Number(m[1] || 0); end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1; }
  if (!(start >= 0) || start >= size || end < start) {
    return new Response(null, { status: 416, headers: { ...ISO, 'Content-Range': `bytes */${size}` } });
  }
  const chunk = body.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      ...ISO,
      'Content-Type': type || 'application/octet-stream',
      'Content-Length': String(chunk.byteLength),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

function decorate(response, fresh) {
  if (response.type !== 'basic' || [101, 204, 205, 304].includes(response.status)) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISO)) headers.set(name, value);
  if (fresh) headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
