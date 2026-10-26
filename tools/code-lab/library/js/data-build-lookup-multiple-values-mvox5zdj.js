function indexManyBy(items, keyFn) {
  const index = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(item);
  }
  return index;
}
const bySymbol = indexManyBy([{s:'A', n:1},{s:'A', n:2},{s:'B', n:3}], x => x.s);
console.log(bySymbol.get('A'));
