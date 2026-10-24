const player = { x: 0, y: 0, vx: 2, vy: 1 };

function update() {
  player.x += player.vx;
  player.y += player.vy;
}