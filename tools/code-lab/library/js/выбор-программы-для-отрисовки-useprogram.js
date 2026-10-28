function makeProgram(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  return program;
}

const canvas = document.createElement("canvas");
canvas.width = 300;
canvas.height = 300;
document.body.append(canvas);
const gl = canvas.getContext("webgl");

function createProgram(offsetX, color) {
  return makeProgram(
    gl,
    `attribute vec2 position; void main() { gl_Position = vec4(position * 0.4 + vec2(${offsetX}, 0.0), 0.0, 1.0); }`,
    `precision mediump float; void main() { gl_FragColor = vec4(${color}, 1.0); }`
  );
}

const leftProgram = createProgram(-0.5, "1.0, 0.3, 0.2");
const rightProgram = createProgram(0.5, "0.2, 0.5, 1.0");

const buffer = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.8, -0.8, 0.8, -0.8, 0, 0.8]), gl.STATIC_DRAW);

gl.clearColor(0, 0, 0, 1);
gl.clear(gl.COLOR_BUFFER_BIT);

for (const program of [leftProgram, rightProgram]) {
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
