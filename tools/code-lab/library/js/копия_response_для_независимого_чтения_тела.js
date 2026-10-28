const ответ = new Response(JSON.stringify({ ок: true }));
const копия = ответ.clone();

console.log(await ответ.text());
console.log(await копия.json());
