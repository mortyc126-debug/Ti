function quantile(values, p) {
  if (!values.length) return null;
  if (!Number.isFinite(p) || p < 0 || p > 1) throw new RangeError('p должен быть в диапазоне 0..1');
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.every(Number.isFinite)) throw new TypeError('Ожидались конечные числа');
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position), upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}
console.log(quantile([1, 2, 10, 20], 0.5));
