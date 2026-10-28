const посещённые = new WeakSet();
const узел = {};
посещённые.add(узел);
console.log(посещённые.has(узел));
