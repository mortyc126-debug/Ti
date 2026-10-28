// адрес по кусочкам — так легче собрать и понять
const база   = "https://iss.moex.com";              // сервер
const путь   = "/iss/securities.json";               // что просим
const параметры = new URLSearchParams({              // настройки после ?
  q: "Сбербанк",        // поиск по тексту
  "iss.meta": "off",    // не слать служебные поля
});
const url = база + путь + "?" + параметры;           // склеили

// шаблон любого GET-запроса:
async function запрос(url){
  const r = await fetch(url);     // сходили
  return await r.json();          // разобрали
}
запрос(url).then(data => console.log(data));