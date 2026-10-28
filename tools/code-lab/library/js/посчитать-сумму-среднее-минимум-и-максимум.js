function summarizeNumbers(values) {
  if (values.length === 0) return { count: 0, sum: 0, mean: null, min: null, max: null };
  let sum = 0, min = Infinity, max = -Infinity;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Ожидались конечные числа');
    sum += value; min = Math.min(min, value); max = Math.max(max, value);
  }
  return { count: values.length, sum, mean: sum / values.length, min, max };
}
console.log(summarizeNumbers([2, 4, 6]));
