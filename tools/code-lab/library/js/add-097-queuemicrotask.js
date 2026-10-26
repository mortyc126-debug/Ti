console.log("A");
queueMicrotask(() => console.log("C"));
console.log("B");
