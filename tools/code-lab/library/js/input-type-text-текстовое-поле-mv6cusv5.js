const field = document.querySelector("#nickname");
const preview = document.querySelector("#preview");

field.addEventListener("input", () => {
  preview.textContent = field.value;
});