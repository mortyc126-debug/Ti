document.body.innerHTML = '<div id="box" class="box">Блок</div>';
const box = document.querySelector("#box");

console.log(box.className);
box.className += " active";
console.log(box.className);
box.className = "box big";
console.log(box.className);
