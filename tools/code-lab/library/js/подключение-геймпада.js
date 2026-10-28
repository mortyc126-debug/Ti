window.addEventListener("gamepadconnected", event => {
  console.log(`Геймпад подключён: ${event.gamepad.id}`);
  console.log(`Кнопок: ${event.gamepad.buttons.length}`);
});

window.addEventListener("gamepaddisconnected", event => {
  console.log(`Геймпад отключён: ${event.gamepad.id}`);
});
