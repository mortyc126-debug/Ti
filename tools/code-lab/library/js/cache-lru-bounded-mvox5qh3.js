function createLruCache(limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit должен быть >= 1');
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key); map.delete(key); map.set(key, value); return value;
    },
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      if (map.size > limit) map.delete(map.keys().next().value);
    },
    has: key => map.has(key),
    get size() { return map.size; }
  };
}
const cache = createLruCache(2); cache.set('a',1); cache.set('b',2); cache.get('a'); cache.set('c',3); console.log(cache.has('b'));
