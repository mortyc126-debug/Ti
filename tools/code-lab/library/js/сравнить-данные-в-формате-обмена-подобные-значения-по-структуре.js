function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(key => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}
console.log(deepEqual({x:[1,2]}, {x:[1,2]}));
