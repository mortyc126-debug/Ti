function showLabel(x, y, message) {
  const label = document.createElement("div");
  label.textContent = message;
  label.style.position = "fixed";
  label.style.left = `${x}px`;
  label.style.top = `${y}px`;
  label.classList.add("screen-label");
  document.body.append(label);
}

showLabel(120, 80, "Привет!");