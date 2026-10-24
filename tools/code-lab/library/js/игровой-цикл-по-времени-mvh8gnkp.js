let last = performance.now();

function loop(now) {
  const dt = (now - last) / 1000;
  last = now;
  player.x += player.vx * dt;
  requestAnimationFrame(loop);
}

requestAnimationFrame(loop);