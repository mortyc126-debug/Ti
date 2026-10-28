const исходный = new Uint8Array([1, 2, 3]);
const копия = new Uint8Array(исходный);

копия[0] = 9;
console.log(исходный[0], копия[0]);
