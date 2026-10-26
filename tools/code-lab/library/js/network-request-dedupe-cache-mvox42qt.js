function createRequestCache({ ttlMs = 5000, now = Date.now } = {}) {
  const values = new Map(), pending = new Map();
  return async function get(key, loader) {
    const cached = values.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(loader).then(value => {
      values.set(key, { value, expiresAt: now() + ttlMs });
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
// const getCached = createRequestCache(); // getCached(url, () => fetch(url).then(r => r.json()))
