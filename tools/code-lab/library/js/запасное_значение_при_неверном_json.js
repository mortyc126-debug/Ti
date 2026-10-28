const ответ = new Response("это не JSON");
const данные = await ответ.json().catch(() => ({ тема: "светлая" }));

console.log(данные);
