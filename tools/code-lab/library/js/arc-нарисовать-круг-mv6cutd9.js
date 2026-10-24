const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");

ctx.beginPath();
ctx.arc(80, 70, 35, 0, Math.PI * 2);
ctx.fillStyle = "#52F2C9";
ctx.fill();