function isFiniteNumberArray(values) {
  return Array.isArray(values) && values.every(Number.isFinite);
}
console.log(isFiniteNumberArray([1, 2.5]), isFiniteNumberArray([1, NaN]));
