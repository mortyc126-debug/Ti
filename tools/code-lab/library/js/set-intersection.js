const a = new Set([1, 2, 3]);
const b = new Set([2, 3, 4]);
const общие = new Set([...a].filter(x => b.has(x)));
console.log([...общие]);
