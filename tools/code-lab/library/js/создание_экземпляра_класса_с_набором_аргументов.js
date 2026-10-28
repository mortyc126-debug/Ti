class Точка {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

function создать(Конструктор, ...аргументы) {
  return new Конструктор(...аргументы);
}

console.log(создать(Точка, 3, 4));
