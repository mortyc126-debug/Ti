async function migrateData() {
  const cache = await caches.open("data-v2");
  await cache.put("/version", new Response("2"));
}

self.addEventListener("activate", event => {
  event.waitUntil(migrateData());
});
