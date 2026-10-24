function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // здесь рисуем кадр
  requestAnimationFrame(draw);
}

draw();