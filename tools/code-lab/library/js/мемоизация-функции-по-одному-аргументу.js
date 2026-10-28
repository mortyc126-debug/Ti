function memoize(fn) {
  const cache = new Map();
  return key => {
    if (cache.has(key)) return cache.get(key);
    const value = fn(key); cache.set(key, value); return value;
  };
}
const square = memoize(n => n * n);
console.log(square(8));
