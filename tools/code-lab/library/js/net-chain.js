const q = u => fetch(u).then(r => r.json());

async function main(){
  // — ЦЕПОЧКА: шаг 2 зависит от шага 1 —
  const поиск = await q("https://iss.moex.com/iss/securities.json?q=Сбербанк&iss.meta=off");
  const secid = поиск.securities.data[0][1];          // берём код из 1-го ответа
  const инфо  = await q("https://iss.moex.com/iss/securities/" + secid + ".json?iss.meta=off");
  console.log("по цепочке, secid:", secid);

  // — ПАРАЛЛЕЛЬНО: запросы НЕ зависят друг от друга —
  const [a, b] = await Promise.all([
    q("https://iss.moex.com/iss/engines.json?iss.meta=off"),
    q("https://iss.moex.com/iss/index.json?iss.meta=off"),
  ]);
  console.log("параллельно пришли оба ответа");
}
main();