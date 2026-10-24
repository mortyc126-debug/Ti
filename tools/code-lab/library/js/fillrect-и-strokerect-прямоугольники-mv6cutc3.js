const canvas = document.querySelector("#scene");
const ctx = canvas.getContext("2d");

ctx.fillStyle = "#FF006E";
ctx.fillRect(20, 20, 100, 60);
ctx.strokeStyle = "#3DD9FF";
ctx.lineWidth = 3;
ctx.strokeRect(140, 20, 100, 60);