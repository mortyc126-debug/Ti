let wasPressed = false;

function update() {
  const [gamepad] = navigator.getGamepads();
  if (gamepad) {
    const isPressed = gamepad.buttons[0].pressed;
    if (isPressed && !wasPressed) console.log("Прыжок!");
    wasPressed = isPressed;
  }
  requestAnimationFrame(update);
}

window.addEventListener("gamepadconnected", () => requestAnimationFrame(update));
