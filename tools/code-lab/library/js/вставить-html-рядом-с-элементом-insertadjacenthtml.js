document.body.innerHTML = '<ul id="list"><li>Хлеб</li></ul>';
const list = document.querySelector("#list");

list.insertAdjacentHTML("beforeend", "<li>Молоко</li>");
list.insertAdjacentHTML("afterbegin", "<li>Сыр</li>");

console.log(list.innerText.split("\n").join(", "));
