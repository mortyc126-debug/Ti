const checkbox = document.querySelector("#showGrid");
const canvas = document.querySelector("#previewCanvas");

checkbox.addEventListener("change", () => {
  canvas.classList.toggle("show-grid", checkbox.checked);
});