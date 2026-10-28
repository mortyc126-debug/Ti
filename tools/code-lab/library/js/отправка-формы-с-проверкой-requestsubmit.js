document.body.innerHTML = '<form id="order"><input name="name" required></form>';
const form = document.querySelector("#order");

form.addEventListener("submit", event => {
  event.preventDefault();
  console.log("submit сработал");
});

form.requestSubmit();
console.log(`Форма валидна: ${form.checkValidity()}`);

form.elements.name.value = "Мира";
form.requestSubmit();
