const canvas = document.createElement("canvas");
canvas.width = 300;
canvas.height = 300;
document.body.append(canvas);
const gl = canvas.getContext("webgl");

gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);
