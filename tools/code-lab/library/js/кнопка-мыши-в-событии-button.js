const names = ["левая", "средняя", "правая"];

document.addEventListener("mousedown", event => {
  console.log(`Кнопка: ${names[event.button] ?? event.button}`);
});
