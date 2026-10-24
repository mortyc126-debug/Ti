const state = { x: 3, y: 0 };

window.addEventListener("keydown", event => {
  if (event.key === "ArrowLeft") state.x -= 1;
  if (event.key === "ArrowRight") state.x += 1;
  if (event.key === "ArrowDown") state.y += 1;

  console.log(state.x, state.y);
});