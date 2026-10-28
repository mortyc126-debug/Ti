self.addEventListener("activate", событие => {
  событие.waitUntil((async () => {
    const окна = await self.clients.matchAll({ type: "window" });
    окна.forEach(окно => окно.postMessage({ тип: "обновление" }));
  })());
});
