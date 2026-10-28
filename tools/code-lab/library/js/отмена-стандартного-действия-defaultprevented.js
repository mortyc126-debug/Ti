document.body.innerHTML = '<a id="link" href="#section">Перейти</a>';
const link = document.querySelector("#link");

link.addEventListener("click", event => event.preventDefault());
link.addEventListener("click", event => {
  console.log(`Отменено: ${event.defaultPrevented}`);
});
