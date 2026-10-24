const particles = [];

function burst(x, y) {
  for (let i = 0; i < 12; i += 1) {
    particles.push({
      x,
      y,
      vx: Math.random() * 4 - 2,
      vy: Math.random() * 4 - 2,
      life: 1
    });
  }
}

function updateParticles() {
  particles.forEach(particle => {
    particle.x += particle.vx;
    particle.y += particle.vy;
    particle.life -= 0.02;
  });
}

particles.length = 0;
burst(100, 80);
updateParticles();
console.log(particles.length);