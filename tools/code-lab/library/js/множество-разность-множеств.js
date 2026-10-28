const a = new Set([1, 2, 3]);
const b = new Set([2, 4]);
console.log([...a].filter(x => !b.has(x)));
