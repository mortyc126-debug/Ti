function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
const result = uniqueBy([{id: 1}, {id: 2}, {id: 1}], x => x.id);
console.log(result);
