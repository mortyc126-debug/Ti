document.body.innerHTML = '<div id="card" style="box-sizing: border-box; width: 200px; padding: 10px; border: 5px solid">Карточка</div>';
const card = document.querySelector("#card");

console.log(`offsetWidth = ${card.offsetWidth}`);
console.log(`clientWidth = ${card.clientWidth}`);
console.log(`getBoundingClientRect = ${card.getBoundingClientRect().width}`);
