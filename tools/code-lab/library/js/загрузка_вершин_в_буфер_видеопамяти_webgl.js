const холст = document.querySelector("canvas");
const контекст = холст.getContext("webgl");

const вершины = [0, 0.5, -0.5, -0.5, 0.5, -0.5];
const буфер = контекст.createBuffer();
контекст.bindBuffer(контекст.ARRAY_BUFFER, буфер);
контекст.bufferData(контекст.ARRAY_BUFFER, new Float32Array(вершины), контекст.STATIC_DRAW);
