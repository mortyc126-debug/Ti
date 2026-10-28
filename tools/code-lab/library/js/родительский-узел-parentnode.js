document.body.innerHTML = '<ul id="menu"><li id="item">Пункт</li></ul>';
const item = document.querySelector("#item");

console.log(document.documentElement.parentNode === document);

item.parentNode.removeChild(item);
console.log(document.querySelector("#menu").children.length);
