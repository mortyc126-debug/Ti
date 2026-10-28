let кадр = 0;
let угол = 0;

function шаг() {
  угол += 2;
  document.querySelector("#стрелка").style.transform = `rotate(${угол}deg)`;
  кадр = requestAnimationFrame(шаг);
}

кадр = requestAnimationFrame(шаг);
document.querySelector("#стоп").addEventListener("click", () => cancelAnimationFrame(кадр));
