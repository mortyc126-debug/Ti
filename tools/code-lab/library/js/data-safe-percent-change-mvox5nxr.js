function percentChange(previous, current) {
  if (![previous, current].every(Number.isFinite)) throw new TypeError('Значения должны быть конечными числами');
  if (previous === 0) return { value: null, reason: 'zero-baseline' };
  return { value: ((current - previous) / Math.abs(previous)) * 100, reason: null };
}
console.log(percentChange(80, 100));
