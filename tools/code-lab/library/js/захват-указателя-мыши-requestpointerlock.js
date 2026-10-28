const canvas = document.createElement("canvas");
canvas.width = 300;
canvas.height = 200;
document.body.append(canvas);

canvas.addEventListener("click", () => canvas.requestPointerLock());

document.addEventListener("mousemove", event => {
  if (document.pointerLockElement === canvas) {
    console.log(`Поворот: ${event.movementX}, ${event.movementY}`);
  }
});
