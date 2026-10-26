function sameArray(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}
console.log(sameArray([1, 2], [1, 2]));
