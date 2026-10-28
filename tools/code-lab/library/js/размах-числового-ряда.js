function размах(данные) {
  if (!данные.length) return null;
  return Math.max(...данные) - Math.min(...данные);
}
console.log(размах([7, 2, 11, 5]));
