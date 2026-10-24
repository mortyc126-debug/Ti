const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");
const gradient = ctx.createLinearGradient(0, 0, 180, 0);

gradient.addColorStop(0, "#FF006E");
gradient.addColorStop(1, "#3DD9FF");
ctx.fillStyle = gradient;
ctx.fillRect(10, 10, 180, 70);