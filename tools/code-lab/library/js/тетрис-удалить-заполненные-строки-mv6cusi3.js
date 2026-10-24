const board = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [0, 1, 0, 0],
  [1, 1, 1, 1]
];

const kept = board.filter(row => row.some(cell => cell === 0));
const cleared = board.length - kept.length;

while (kept.length < board.length) {
  kept.unshift(Array(4).fill(0));
}

console.log(cleared);
console.log(kept.length);