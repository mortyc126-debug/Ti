const кнопка = document.querySelector(".btn");
кнопка.addEventListener("click", () => {
  кнопка.textContent = "нажато!";   // меняем элемент в ответ
});

// делегирование: один слушатель на список ловит клики по пунктам
список.addEventListener("click", (e) => {
  if(e.target.matches("li")) console.log(e.target.textContent);
});