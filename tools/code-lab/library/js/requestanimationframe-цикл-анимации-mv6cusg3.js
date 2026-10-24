let frame = 0;

function animate() {
  frame += 1;
  console.log("Кадр", frame);

  if (frame < 3) {
    requestAnimationFrame(animate);
  }
}

requestAnimationFrame(animate);