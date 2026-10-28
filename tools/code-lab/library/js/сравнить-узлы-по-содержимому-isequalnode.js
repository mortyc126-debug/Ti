document.body.innerHTML = '<li id="item" class="item">Хлеб</li>';
const item = document.querySelector("#item");
const copy = item.cloneNode(true);

console.log(item === copy, item.isEqualNode(copy));

copy.textContent = "Сыр";
console.log(item.isEqualNode(copy));
