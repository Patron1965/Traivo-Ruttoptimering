/* Static app shell only. Private data belongs to the owner-scoped IndexedDB store. */
const CACHE_PREFIX = "traivo-driver-shell-";
const CACHE = `${CACHE_PREFIX}v1`;
const ROOT = new URL("./", self.location.href);
const SHELL = ["./", "./driver.webmanifest", "./driver-icon.png"].map(path => new URL(path, ROOT).href);
const staticAsset = url =>
  url.origin === ROOT.origin && url.pathname.startsWith(ROOT.pathname) &&
  !url.pathname.includes("/api/") &&
  (url.pathname.startsWith(`${ROOT.pathname}_expo/static/`) ||
    url.pathname.startsWith(`${ROOT.pathname}assets/`) ||
    url.pathname === `${ROOT.pathname}driver-icon.png`) &&
  !url.search;

self.addEventListener("install", event => {
  // Never skipWaiting automatically: the active client may have unsaved work.
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== ROOT.origin ||
    !url.pathname.startsWith(ROOT.pathname) || url.pathname.includes("/api/")) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(async () => {
      const response = await caches.match(ROOT.href, { cacheName: CACHE });
      return response ?? new Response("Appen är inte förberedd för offlinebruk. Anslut till nätet.", { status: 503 });
    }));
  } else if (staticAsset(url)) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response.ok && response.type !== "opaque") await cache.put(event.request, response.clone());
      return response;
    }));
  }
});
