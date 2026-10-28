function среднее(значения) {
  if (!Array.isArray(значения)) throw new TypeError("Ожидался массив");
  if (значения.length === 0) throw new RangeError("Массив пуст");
  return значения.reduce((s, x) => s + x, 0) / значения.length;
}
