const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");

ctx.beginPath();
ctx.moveTo(20, 100);
ctx.lineTo(100, 20);
ctx.lineTo(180, 100);
ctx.strokeStyle = "#B45CFF";
ctx.lineWidth = 4;
ctx.stroke();