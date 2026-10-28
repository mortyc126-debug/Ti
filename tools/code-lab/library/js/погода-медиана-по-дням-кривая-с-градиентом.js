// ЗАДАЧА: взять погоду с сайта → медианная температура по дням →
// нарисовать кривую с розовым градиентом и датой при наведении.
// Читай снизу вверх по смыслу: main() в конце запускает всю цепочку.

// ── Шаг 1. ОТКУДА данные. Асинхронно просим у открытого API (без ключа).
async function погода(широта, долгота){
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + широта +
    "&longitude=" + долгота + "&hourly=temperature_2m";
  const ответ = await fetch(url);   // await = подожди, пока придёт из сети
  return await ответ.json();        // текст ответа → объект
}

// ── Шаг 2. ОБРАБОТКА: сгруппировать по дню и взять медиану.
function медианаПоДням(данные){
  const времена = данные.hourly.time;           // ["2026-10-11T00:00", ...]
  const темпы   = данные.hourly.temperature_2m;  // [12.3, 11.8, ...]
  const поДням = {};                             // день → список температур
  времена.forEach((t, i) => {
    const день = t.slice(0, 10);                 // "2026-10-11"
    поДням[день] = поДням[день] || [];
    поДням[день].push(темпы[i]);
  });
  return Object.entries(поДням).map(пара => ({
    день: пара[0],
    медиана: медиана(пара[1]),
  }));
}

function медиана(список){
  const s = список.slice().sort((a, b) => a - b);  // копия по возрастанию
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ── Шаг 3. ВЫВОД: кривая (SVG) с розовым градиентом и точками-подсказками.
function нарисовать(дни){
  const W = 600, H = 200, pad = 30;
  const значения = дни.map(d => d.медиана);
  const min = Math.min.apply(null, значения);
  const max = Math.max.apply(null, значения);
  const x = i => pad + i * (W - 2 * pad) / (дни.length - 1);
  const y = v => H - pad - (v - min) / (max - min || 1) * (H - 2 * pad);
  const линия = дни.map((d, i) => x(i) + "," + y(d.медиана)).join(" ");
  const точки = дни.map((d, i) =>
    '<circle cx="' + x(i) + '" cy="' + y(d.медиана) + '" r="4" fill="#FF2FAE">' +
    '<title>' + d.день + ": " + d.медиана + "°</title></circle>").join("");
  const градиент = '<defs><linearGradient id="g" x1="0" x2="1">' +
    '<stop offset="0" stop-color="#FF2FAE"/>' +
    '<stop offset="1" stop-color="#FF006E"/></linearGradient></defs>';
  const svg = '<svg width="' + W + '" height="' + H + '">' + градиент +
    '<polyline points="' + линия + '" fill="none" stroke="url(#g)" stroke-width="3"/>' +
    точки + "</svg>";
  document.querySelector("#out").innerHTML = svg;   // <title> сам всплывает при наведении
}

// ── Шаг 4. СВЯЗАТЬ всё: вот он, порядок. Данные → обработка → рисунок.
async function main(){
  const данные = await погода(55.75, 37.62);   // Москва
  const дни = медианаПоДням(данные);
  нарисовать(дни);
}
main();