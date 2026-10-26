function divide(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError("Аргументы должны быть конечными числами");
  if (b === 0) throw new RangeError("Деление на ноль");
  return a / b;
}
console.log(divide(10, 2));
