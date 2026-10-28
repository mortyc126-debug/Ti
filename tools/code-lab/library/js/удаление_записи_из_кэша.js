const кэш = await caches.open("ресурсы-v1");
console.log(await кэш.delete("/старый.js"));
