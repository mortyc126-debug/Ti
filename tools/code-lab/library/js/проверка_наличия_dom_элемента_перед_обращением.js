const карточка = document.querySelector("#карточка");

if (карточка) {
  карточка.textContent = "Готово";
} else {
  console.warn("Карточка не найдена");
}
