const байты = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
const instance = new WebAssembly.Instance(new WebAssembly.Module(байты)); // модуль с экспортом memory

const memory = instance.exports.memory;
const закодировано = new TextEncoder().encode("Привет, мир");
const pointer = 16;
const length = закодировано.length;
new Uint8Array(memory.buffer).set(закодировано, pointer);

console.log(new TextDecoder().decode(new Uint8Array(memory.buffer, pointer, length)));
