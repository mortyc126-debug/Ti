const зеркала = ["https://a.example.com/data", "https://b.example.com/data"];
const контроллер = new AbortController();

const запросы = зеркала.map(адрес => fetch(адрес, { signal: контроллер.signal }));
запросы.forEach(запрос => запрос.catch(() => {}));

const ответ = await Promise.race(запросы).finally(() => контроллер.abort());
console.log(ответ.url);
