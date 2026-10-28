function createTtlCache(now = Date.now) {
  const store = new Map();
  return {
    set(key, value, ttlMs) { store.set(key, { value, expiresAt: now() + ttlMs }); },
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { store.delete(key); return undefined; }
      return entry.value;
    },
    delete: key => store.delete(key),
    clear: () => store.clear()
  };
}
const cache = createTtlCache(); cache.set('x', 42, 1000); console.log(cache.get('x'));
