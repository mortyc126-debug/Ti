document.body.innerHTML = '<div id="card" class="card active highlighted">Карточка</div>';
const card = document.querySelector("#card");

card.classList.remove("highlighted");
console.log(card.className);

card.classList.remove("нет-такого");
console.log(card.className);
