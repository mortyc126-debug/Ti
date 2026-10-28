const холст = document.querySelector("#сцена");
let работает = true;

холст.addEventListener("webglcontextlost", событие => {
  событие.preventDefault();
  работает = false;
});

холст.addEventListener("webglcontextrestored", () => {
  создатьШейдерыИБуферы();
  работает = true;
  отрисовать();
});
