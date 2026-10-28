document.body.innerHTML = '<p id="title" class="big">Привет</p>';
const title = document.querySelector("#title");

console.log(title.outerHTML);
console.log(title.innerHTML);

title.outerHTML = '<h2 id="title">Заголовок</h2>';
console.log(document.body.innerHTML);
