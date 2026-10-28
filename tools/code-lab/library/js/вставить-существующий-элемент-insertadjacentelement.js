document.body.innerHTML = '<p id="text">Текст</p>';
const text = document.querySelector("#text");

const hint = document.createElement("small");
hint.textContent = "Подсказка";
text.insertAdjacentElement("afterend", hint);

console.log(document.body.innerHTML);
