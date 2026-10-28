document.body.innerHTML = '<ul id="menu"><li id="item">Пункт</li></ul>';
const item = document.querySelector("#item");

console.log(item.parentElement.id);
console.log(document.documentElement.parentElement);
