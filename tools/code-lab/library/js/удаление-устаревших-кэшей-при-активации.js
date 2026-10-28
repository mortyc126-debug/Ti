const currentCache = "app-v2";

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== currentCache).map(key => caches.delete(key))
      )
    )
  );
});
