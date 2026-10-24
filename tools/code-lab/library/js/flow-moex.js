async function main(){
  const url = "https://iss.moex.com/iss/engines/stock/markets/bonds/boards/TQCB/securities.json"
    + "?iss.meta=off&securities.columns=SECID,SECNAME&marketdata.columns=SECID,YIELD";
  const ответ = await fetch(url);
  const данные = await ответ.json();

  // имена: {SECID: название}
  const имена = {};
  данные.securities.data.forEach(r => имена[r[0]] = r[1]);

  // доходности → объекты → отбор > 20% → сортировка
  const список = данные.marketdata.data
    .map(r => ({ secid: r[0], доходность: r[1], имя: имена[r[0]] }))
    .filter(x => x.доходность > 20)
    .sort((a, b) => b.доходность - a.доходность);

  таблица(список);
}

function таблица(список){
  const строки = список.map(x =>
    "<tr><td>" + (x.имя || x.secid) + "</td><td>" + x.доходность + "%</td></tr>").join("");
  document.querySelector("#out").innerHTML =
    "<table cellpadding='4' style='color:#F6F4FF'>" + строки + "</table>";
}
main();