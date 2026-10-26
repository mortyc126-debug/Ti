function median(values) {
  if (!values.length) return null;
  if (!values.every(Number.isFinite)) throw new TypeError('Ожидались конечные числа');
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
console.log(median([8, 1, 4, 2]));
