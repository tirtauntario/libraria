/**
 * Web Share Target (Android): the installed app appears in the system share
 * sheet, and shared books arrive here as a multipart POST to ./share-target
 * (see share_target in vite.config.ts). Loaded into the generated service
 * worker with importScripts, before Workbox's own fetch handler.
 *
 * The files are parked in a cache and the app is opened; on start it imports
 * whatever is waiting (importSharedFiles in src/lib/stores/importer.svelte.ts,
 * which uses the same cache name and headers).
 */
const SHARE_CACHE = 'libraria-share';
const SHARE_FIELD = 'books';

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'POST') return;
  const scope = self.registration.scope;
  if (new URL(request.url).pathname !== new URL('share-target', scope).pathname) return;
  event.respondWith(
    (async () => {
      try {
        const form = await request.formData();
        const files = form.getAll(SHARE_FIELD).filter((f) => typeof f !== 'string');
        const cache = await caches.open(SHARE_CACHE);
        const stamp = Date.now();
        await Promise.all(
          files.map((file, i) =>
            cache.put(
              new URL(`shared/${stamp}-${i}`, scope).href,
              new Response(file, {
                headers: { 'content-type': file.type || 'application/octet-stream', 'x-libraria-name': encodeURIComponent(file.name) },
              }),
            ),
          ),
        );
      } catch (err) {
        console.error('Share target failed', err);
      }
      return Response.redirect(scope, 303);
    })(),
  );
});
