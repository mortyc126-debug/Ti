function circlesHit(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y) < a.r + b.r;
}