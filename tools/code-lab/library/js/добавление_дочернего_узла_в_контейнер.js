const коробка = document.querySelector(".коробка");
const пункт = document.createElement("span");
пункт.textContent = "Новый пункт";

коробка.appendChild(пункт);
console.log(коробка.children.length);
