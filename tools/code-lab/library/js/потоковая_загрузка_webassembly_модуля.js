const { instance } = await WebAssembly.instantiateStreaming(
  fetch("module.wasm"),
  {}
);

console.log(Object.keys(instance.exports));
