const picker = document.querySelector("#colorPicker");
const swatch = document.querySelector("#swatch");

picker.addEventListener("input", () => {
  swatch.style.backgroundColor = picker.value;
});