let playerX = 150;

function update() {
  const [gamepad] = navigator.getGamepads();
  if (gamepad) {
    const stickX = gamepad.axes[0];
    if (Math.abs(stickX) > 0.1) playerX += stickX * 5;
    console.log(`Стик: ${stickX.toFixed(2)}, x = ${playerX.toFixed(0)}`);
  }
  requestAnimationFrame(update);
}

window.addEventListener("gamepadconnected", () => requestAnimationFrame(update));
