// рисуем поле, кнопку и место для ответа
document.querySelector("#out").innerHTML =
  '<input id="n" value="10" style="width:60px"> ' +
  '<button id="go">+ удвоить</button> <span id="res"></span>';

let всего = 0;   // состояние: копится между нажатиями

document.querySelector("#go").addEventListener("click", () => {
  const n = Number(document.querySelector("#n").value); // вход: из поля
  const удвоено = n * 2;                                 // расчёт
  всего = всего + удвоено;                               // обновляем состояние
  document.querySelector("#res").textContent = "итог: " + всего; // вывод
});