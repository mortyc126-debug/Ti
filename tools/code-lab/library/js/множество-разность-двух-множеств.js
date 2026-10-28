const a = new Set([1, 2, 3]);
const b = new Set([2, 4]);
const onlyA = [...a].filter(value => !b.has(value));
console.log(onlyA);
