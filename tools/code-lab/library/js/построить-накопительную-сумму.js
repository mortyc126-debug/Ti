function runningTotal(values) {
  let total = 0;
  return values.map(value => (total += value));
}
console.log(runningTotal([2, 3, -1, 4]));
