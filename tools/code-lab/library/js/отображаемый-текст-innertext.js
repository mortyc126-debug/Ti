document.body.innerHTML = '<div id="card"><span>Видимый</span><span style="display: none">Скрытый</span></div>';
const card = document.querySelector("#card");

console.log(card.innerText);
console.log(card.textContent);
