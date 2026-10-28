const память = new SharedArrayBuffer(4);
const числа = new Int32Array(память);
Atomics.store(числа, 0, 17);
console.log(Atomics.load(числа, 0));
