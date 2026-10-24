const box = document.querySelector('.box');
let x = 0;

function frame() {
  x += 2;
  box.style.transform = `translateX(${x}px)`;
  if (x < 300) requestAnimationFrame(frame);
}

requestAnimationFrame(frame);