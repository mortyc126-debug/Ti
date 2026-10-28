function indexBy(items, keyFn) {
  const index = new Map();
  for (const item of items) index.set(keyFn(item), item);
  return index;
}
const byId = indexBy([{id: 'a', value: 3}, {id: 'b', value: 7}], x => x.id);
console.log(byId.get('b'));
