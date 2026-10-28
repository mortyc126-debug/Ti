document.body.innerHTML = '<ul><li id="a">Один</li><li id="b">Два</li></ul>';
const first = document.querySelector("#a");
const last = document.querySelector("#b");

console.log(first.nextElementSibling.id);
console.log(last.nextElementSibling);
