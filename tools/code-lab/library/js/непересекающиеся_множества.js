const а = new Set([1, 2]);
const б = new Set([3, 4]);
console.log(![...а].some(x => б.has(x)));
