async function безопасныйЗапрос(url){
  console.log("→ идём на:", url);          // 1) видно, КУДА
  let r;
  try {
    r = await fetch(url);                   // нет связи/сбой → в catch
  } catch(e){
    console.log("⛔ сеть не ответила:", e.message);
    return null;
  }
  console.log("← статус:", r.status);       // 2) 200 ок · 404 нет · 500 сервер упал
  if(!r.ok){
    console.log("⛔ сервер вернул ошибку", r.status);
    return null;
  }
  const текст = await r.text();             // 3) сначала как ТЕКСТ
  try {
    return JSON.parse(текст);               // 4) пробуем разобрать
  } catch(e){
    console.log("⛔ это не JSON. Начало ответа:", текст.slice(0, 100));
    return null;
  }
}

// проба с заведомо битым адресом:
безопасныйЗапрос("https://iss.moex.com/iss/НЕТУ.json")
  .then(d => console.log("итог:", d));