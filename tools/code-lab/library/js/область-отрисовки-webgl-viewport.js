const canvas = document.createElement("canvas");
canvas.width = 300;
canvas.height = 300;
document.body.append(canvas);
const gl = canvas.getContext("webgl");

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = 300;
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0.1, 0.4, 0.8, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

resize();
window.addEventListener("resize", resize);
