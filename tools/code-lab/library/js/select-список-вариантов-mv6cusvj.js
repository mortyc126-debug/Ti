const select = document.querySelector("#theme");
const page = document.querySelector("body");

select.addEventListener("change", () => {
  page.dataset.theme = select.value;
});