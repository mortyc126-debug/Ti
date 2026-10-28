function rollingMean(values, windowSize) {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new RangeError('windowSize должен быть >= 1');
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) throw new TypeError('Ожидались конечные числа');
    sum += values[i];
    if (i >= windowSize) sum -= values[i - windowSize];
    if (i >= windowSize - 1) result[i] = sum / windowSize;
  }
  return result;
}
console.log(rollingMean([1,2,3,4,5], 3));
