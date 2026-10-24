const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");
const image = document.querySelector("#sourceImage");

image.addEventListener("load", () => {
  ctx.drawImage(image, 10, 10, 120, 80);
});