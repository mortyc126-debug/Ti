class Позиция {
  constructor(x) { this._x = x; }
  get x() { return this._x; }
  set x(значение) { if (Number.isFinite(значение)) this._x = значение; }
}
const точка = new Позиция(3);
точка.x = 8;
console.log(точка.x);
