function показатьМеню(развёрнуто) {
  const кнопка = document.querySelector("#меню-кнопка");
  кнопка?.setAttribute("aria-expanded", String(развёрнуто));
}

показатьМеню(true);
