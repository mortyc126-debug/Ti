function addScore(points) {
  state.score += points;
}

function loseLife() {
  state.lives -= 1;
  if (state.lives <= 0) state.running = false;
}