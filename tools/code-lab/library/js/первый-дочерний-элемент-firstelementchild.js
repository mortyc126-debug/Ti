document.body.innerHTML = `
  <ul id="menu">
    <li>Главная</li>
    <li>Каталог</li>
  </ul>`;
const menu = document.querySelector("#menu");

console.log(menu.firstChild.nodeName);
console.log(menu.firstElementChild.textContent);
