const area = document.createElement("div");
area.textContent = "Нажмите правой кнопкой";
area.style.padding = "40px";
document.body.append(area);

area.addEventListener("contextmenu", event => event.preventDefault());
area.addEventListener("contextmenu", event => {
  console.log(`Своё меню в точке ${event.clientX}, ${event.clientY}`);
});
