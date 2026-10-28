const кэш = await caches.open("ресурсы-v1");
await кэш.addAll(["/index.html", "/style.css"]);
