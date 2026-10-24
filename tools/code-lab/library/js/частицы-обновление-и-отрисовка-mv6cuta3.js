const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");
const particles = [
  { x: 30, y: 40, vx: 1.5, vy: -0.5 },
  { x: 80, y: 60, vx: -1, vy: 1 }
];

function drawFrame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  particles.forEach(particle => {
    particle.x += particle.vx;
    particle.y += particle.vy;
    ctx.fillRect(particle.x, particle.y, 4, 4);
  });
}

drawFrame();