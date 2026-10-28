let totalShift = 0;

document.addEventListener("mousemove", event => {
  totalShift += event.movementX;
  console.log(`Сдвиг: ${event.movementX}, всего: ${totalShift}`);
});
