const input = document.querySelector("input");
const search = debounce(value => console.log("Ищем:", value), 250);
input.addEventListener("input", event => search(event.target.value));
