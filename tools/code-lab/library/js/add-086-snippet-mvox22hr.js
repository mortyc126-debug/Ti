function safeMetric(value) {
  return Number.isFinite(value) ? value : null;
}
console.log(safeMetric(0.12), safeMetric(Infinity));
