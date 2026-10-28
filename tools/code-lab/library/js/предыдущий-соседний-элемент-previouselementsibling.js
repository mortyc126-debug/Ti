document.body.innerHTML = '<ul><li id="a">Один</li><li id="b">Два</li></ul>';
const first = document.querySelector("#a");
const last = document.querySelector("#b");

console.log(last.previousElementSibling.id);
console.log(first.previousElementSibling);
