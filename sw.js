// Service worker for offline support of the app shell.
//
// Strategies:
// - App shell (html/css/js/icons/manifest)  -> cache-first
// - vocab/index.json + vocab/*.md           -> network-first  (fresh on every load,
//                                              cache as fallback)
// - vocab/audio/<stem>/manifest.json        -> network-first  (cheap, must be fresh
//                                              so new entries appear)
// - vocab/audio/<stem>/**/*.mp3             -> cache-first    (large + immutable; once
//                                              fetched, play from cache forever so
//                                              background / lock-screen playback works
//                                              with no network)

const CACHE = "vocab-pwa-v4";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./style.css",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

function isAudioFile(pathname) {
  return /\/vocab\/audio\/.+\.mp3$/i.test(pathname);
}

function isManifestOrVocab(pathname) {
  // Per-file audio manifests + raw vocab files + the file index.
  return (
    /\/vocab\/audio\/.+\/manifest\.json$/i.test(pathname) ||
    /\/vocab\/[^/]+\.md$/i.test(pathname) ||
    /\/vocab\/index\.json$/i.test(pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Audio files: cache-first. Range requests bypass the cache so the browser
  // can seek; we accept a single full fetch and serve range from network.
  if (isAudioFile(url.pathname)) {
    if (req.headers.has("range")) return; // let the browser handle 206 Partial.
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res.ok && res.status === 200) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Manifests + raw vocab: network-first.
  if (isManifestOrVocab(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Cache-first for app shell.
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }),
    ),
  );
});
