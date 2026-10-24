const ctx = document.querySelector("canvas").getContext("2d");

const значения = [40, 70, 30, 90];
значения.forEach((v, i) => {
  ctx.fillStyle = "#3DD9FF";
  ctx.fillRect(i * 30, 100 - v, 20, v); // x, y, ширина, высота
});