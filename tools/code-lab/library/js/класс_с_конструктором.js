class Точка {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }

  расстояние() {
    return Math.hypot(this.x, this.y);
  }
}

console.log(new Точка(3, 4).расстояние());
