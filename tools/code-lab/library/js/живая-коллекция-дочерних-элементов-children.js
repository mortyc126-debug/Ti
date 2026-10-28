document.body.innerHTML = '<ul id="menu"><li>Главная</li><li>Каталог</li></ul>';
const menu = document.querySelector("#menu");
const items = menu.children;

console.log(items.length);

const extra = document.createElement("li");
extra.textContent = "Контакты";
menu.append(extra);

console.log(items.length, items[2].textContent);
