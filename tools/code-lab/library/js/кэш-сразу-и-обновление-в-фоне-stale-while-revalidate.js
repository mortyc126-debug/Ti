const cacheName = "pages-v1";

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.open(cacheName).then(async cache => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request).then(response => {
        cache.put(event.request, response.clone());
        return response;
      });
      return cached ?? network;
    })
  );
});
