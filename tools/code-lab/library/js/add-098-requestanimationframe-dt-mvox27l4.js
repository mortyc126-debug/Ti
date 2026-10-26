let last = 0;
function frame(now) {
  const dt = Math.min((now - last) / 1000 || 0, 0.05);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
