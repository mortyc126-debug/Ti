const rows = 4;
const columns = 6;
const board = Array.from(
  { length: rows },
  () => Array(columns).fill(0)
);

board[2][3] = 1;
board[2][4] = 1;
console.log(board[2]);