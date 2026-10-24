const field = document.querySelector("#colorName");

field.addEventListener("input", event => {
  console.log("Сейчас:", event.target.value);
});

field.addEventListener("change", event => {
  console.log("Подтверждено:", event.target.value);
});