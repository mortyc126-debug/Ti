function canPlace(board, cells) {
  return cells.every(([x, y]) => {
    const inside = y >= 0 && y < board.length &&
      x >= 0 && x < board[0].length;
    return inside && board[y][x] === 0;
  });
}

const board = Array.from({ length: 4 }, () => Array(6).fill(0));
console.log(canPlace(board, [[2, 1], [3, 1]]));