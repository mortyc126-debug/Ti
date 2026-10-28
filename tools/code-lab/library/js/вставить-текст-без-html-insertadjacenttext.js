document.body.innerHTML = '<div id="box"></div>';
const box = document.querySelector("#box");

const userInput = "<b>не жирный</b>";
box.insertAdjacentText("beforeend", userInput);

console.log(box.innerHTML);
console.log(box.children.length);
