const байты = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1, 7, 10, 1, 6, 109, 101, 109, 111, 114, 121, 2, 0]);
const instance = new WebAssembly.Instance(new WebAssembly.Module(байты)); // модуль с экспортом memory

const pointer = 8;
const length = 4;
const область = new Uint8Array(instance.exports.memory.buffer, pointer, length);
область.set([10, 20, 30, 40]);
console.log(область);
console.log(область.byteOffset, область.length);
