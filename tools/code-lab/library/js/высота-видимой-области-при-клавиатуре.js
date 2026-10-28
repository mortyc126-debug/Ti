const panel = document.createElement("div");
panel.textContent = "Панель над клавиатурой";
Object.assign(panel.style, {
  position: "fixed",
  left: "0",
  right: "0",
  bottom: "0",
  padding: "12px",
  background: "#eee",
});
document.body.append(panel);

function placePanel() {
  const viewport = window.visualViewport;
  const hiddenByKeyboard = window.innerHeight - viewport.height - viewport.offsetTop;
  panel.style.bottom = `${Math.max(0, hiddenByKeyboard)}px`;
  console.log(`Высота видимой области: ${Math.round(window.visualViewport.height)}px`);
}

placePanel();
window.visualViewport.addEventListener("resize", placePanel);
