function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

player.x = clamp(player.x, 0, canvas.width - 20);