const кэш = await caches.open("ответы-v1");
const ответ = await fetch("/данные.json");
await кэш.put("/данные.json", ответ.clone());
