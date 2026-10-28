const память = new SharedArrayBuffer(4);
const ячейки = new Int32Array(память);
const ожидание = Atomics.waitAsync(ячейки, 0, 0, 100);
console.log(ожидание.async);
