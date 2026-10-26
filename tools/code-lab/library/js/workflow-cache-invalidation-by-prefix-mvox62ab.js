function deleteByPrefix(map, prefix) {
  let removed = 0;
  for (const key of map.keys()) {
    if (typeof key === 'string' && key.startsWith(prefix)) { map.delete(key); removed++; }
  }
  return removed;
}
const cache = new Map([['user:1',{}], ['user:2',{}], ['price:1',{}]]);
console.log(deleteByPrefix(cache, 'user:'));
