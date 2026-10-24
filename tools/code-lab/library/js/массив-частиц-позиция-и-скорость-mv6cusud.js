const particles = [
  { x: 50, y: 50, vx: 2, vy: -1 },
  { x: 80, y: 40, vx: -1, vy: 2 }
];

particles.forEach(particle => {
  particle.x += particle.vx;
  particle.y += particle.vy;
});

console.log(particles.map(p => [p.x, p.y]));