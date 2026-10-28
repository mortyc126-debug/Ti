self.addEventListener("fetch", событие => {
  событие.respondWith((async () => {
    const кэш = await caches.open("страницы-v1");
    const сохранённый = await кэш.match(событие.request);
    return сохранённый ?? fetch(событие.request);
  })());
});
