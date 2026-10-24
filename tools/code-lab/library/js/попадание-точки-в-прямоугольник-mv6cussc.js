function containsPoint(x, y, rect) {
  return x >= rect.x &&
    x <= rect.x + rect.width &&
    y >= rect.y &&
    y <= rect.y + rect.height;
}

const button = { x: 20, y: 30, width: 100, height: 40 };
console.log(containsPoint(50, 45, button));