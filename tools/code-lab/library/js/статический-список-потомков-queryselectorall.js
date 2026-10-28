document.body.innerHTML = '<ul id="list"><li class="done">Хлеб</li><li>Сыр</li><li class="done">Молоко</li></ul>';
const list = document.querySelector("#list");
const doneItems = list.querySelectorAll("li.done");

console.log(doneItems.length);
list.insertAdjacentHTML("beforeend", '<li class="done">Яйца</li>');
console.log(doneItems.length, list.querySelectorAll("li.done").length);
