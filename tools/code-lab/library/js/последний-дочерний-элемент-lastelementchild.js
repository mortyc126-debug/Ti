document.body.innerHTML = `
  <ol id="steps">
    <li>Старт</li>
    <li>Финиш</li>
  </ol>`;
const steps = document.querySelector("#steps");

console.log(steps.lastChild.nodeName);
console.log(steps.lastElementChild.textContent);
