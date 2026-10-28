self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached ?? fetch(event.request))
  );
});
