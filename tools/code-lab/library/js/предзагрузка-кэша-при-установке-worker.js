const currentCache = "app-v1";
const assets = ["/", "/styles.css", "/app.js", "/logo.svg"];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(currentCache).then(cache => cache.addAll(assets))
  );
});
