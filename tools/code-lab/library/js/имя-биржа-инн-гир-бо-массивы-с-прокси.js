// Прокси обходит CORS к bo.nalog.gov.ru. По умолчанию — публичный corsproxy.io.
const ПРОКСИ = "https://corsproxy.io/?";   // свой CF Worker: "https://…workers.dev/?u="

// собрать адрес через прокси по соглашению проекта
function черезПрокси(target){
  if(ПРОКСИ.endsWith("=")) return ПРОКСИ + encodeURIComponent(target); // …/?u= → кодируем
  return ПРОКСИ + target;                                             // …/?   → как есть
}
const гирбо = путь => черезПрокси("https://bo.nalog.gov.ru" + путь);
const q = u => fetch(u, { headers: { Accept: "application/json" } }).then(r => r.json());

// Шаг 1–2: имя → MOEX → ИНН эмитента
async function поИмениИНН(имя){
  const j = await q("https://iss.moex.com/iss/securities.json?iss.meta=off&q=" + encodeURIComponent(имя));
  const кол = j.securities.columns;
  const стр = j.securities.data[0];
  if(!стр) throw new Error("на бирже нет: " + имя);
  return String(стр[кол.indexOf("emitent_inn")] || "");
}

// Шаг 3–4: ИНН → ГИР БО → годы отчётов в массив
async function отчётность(ИНН){
  const найдено = await q(гирбо("/advanced-search/organizations/search?inn=" + ИНН));
  const orgs = найдено.content || найдено;      // список организаций
  const org = orgs[0];
  if(!org) throw new Error("в ГИР БО нет ИНН " + ИНН);
  const bfo = await q(гирбо("/nbo/organizations/" + org.id + "/bfo/")); // список отчётов
  const список = bfo.content || bfo;
  const годы = список
    .filter(b => String(b.period).length === 4)   // только годовые
    .map(b => Number(b.period))
    .sort((a, b) => b - a);
  return { orgId: org.id, годы };                 // ответ → массив лет
}

async function main(){
  const ИНН = await поИмениИНН("Сбербанк");       // ← имя из Т-Инвестиций
  console.log("ИНН эмитента:", ИНН);
  const r = await отчётность(ИНН);
  console.log("orgId:", r.orgId, "годы:", r.годы);
  // дальше по каждому году: /nbo/details/balance?id= и /nbo/details/financial_result?id=
  // → оттуда выручка (код 2110), активы (1600) и т.д. в массивы по годам.
}
main();