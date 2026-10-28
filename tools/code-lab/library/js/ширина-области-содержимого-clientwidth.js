document.body.innerHTML = '<div id="panel" style="width: 200px; padding: 10px; border: 5px solid black">Панель</div>';
const panel = document.querySelector("#panel");

console.log(`clientWidth = ${panel.clientWidth}`);
console.log(`offsetWidth = ${panel.offsetWidth}`);
