function rollingStdDev(values, windowSize) {
  if (!Number.isInteger(windowSize) || windowSize < 2) throw new RangeError('windowSize должен быть >= 2');
  const result = new Array(values.length).fill(null);
  for (let end = windowSize; end <= values.length; end++) {
    const window = values.slice(end - windowSize, end);
    if (!window.every(Number.isFinite)) throw new TypeError('Ожидались конечные числа');
    const mean = window.reduce((sum, value) => sum + value, 0) / windowSize;
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (windowSize - 1);
    result[end - 1] = Math.sqrt(variance);
  }
  return result;
}
// const vol = rollingStdDev(returns, 20);
