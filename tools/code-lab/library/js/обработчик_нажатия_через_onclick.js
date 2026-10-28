const кнопка = document.querySelector("#счётчик");
let нажатий = 0;

кнопка.onclick = () => {
  нажатий += 1;
  кнопка.textContent = `Нажато: ${нажатий}`;
};
