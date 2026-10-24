const slider = document.querySelector("#intensity");
const valueLabel = document.querySelector("#intensityValue");

slider.addEventListener("input", () => {
  valueLabel.textContent = `${slider.value}%`;
});