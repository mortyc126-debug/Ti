function total(...values) {
  return values.reduce((sum, value) => sum + value, 0);
}
console.log(total(2, 3, 5));
