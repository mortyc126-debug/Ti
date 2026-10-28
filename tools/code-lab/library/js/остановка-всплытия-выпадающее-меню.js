document.body.innerHTML = '<div id="menu">Меню <button id="item">Пункт</button></div>';
const menu = document.querySelector("#menu");
let isOpen = true;

document.addEventListener("click", () => {
  isOpen = false;
  console.log("меню закрыто кликом вне его");
});

menu.addEventListener("click", event => {
  event.stopPropagation();
  console.log(`клик внутри меню, isOpen = ${isOpen}`);
});
