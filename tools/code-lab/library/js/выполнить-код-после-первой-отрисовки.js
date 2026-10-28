const box = document.createElement("div");
box.textContent = "Привет";
box.style.transition = "opacity 1s";
box.style.opacity = "0";
document.body.append(box);

requestAnimationFrame(() => requestAnimationFrame(() => {
  box.style.opacity = "1";
}));
