const canvas = document.createElement("canvas");
canvas.width = 320;
canvas.height = 180;
const context = canvas.getContext("2d");

let frame = 0;
function drawFrame() {
  context.fillStyle = `hsl(${frame % 360} 70% 50%)`;
  context.fillRect(0, 0, canvas.width, canvas.height);
  frame += 2;
  requestAnimationFrame(drawFrame);
}
drawFrame();

const stream = canvas.captureStream(30);

const preview = document.createElement("video");
preview.srcObject = stream;
preview.muted = true;
preview.autoplay = true;
preview.playsInline = true;
document.body.append(preview);
