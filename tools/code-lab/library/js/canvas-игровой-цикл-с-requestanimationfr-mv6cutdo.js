const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");
let x = 10;
let vx = 2;

function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  x += vx;

  if (x > canvas.width - 20 || x < 20) {
    vx *= -1;
  }

  ctx.beginPath();
  ctx.arc(x, 40, 20, 0, Math.PI * 2);
  ctx.fillStyle = "#FF006E";
  ctx.fill();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);