function createIdempotentRunner() {
  const completed = new Map(), pending = new Map();
  return async function run(key, operation) {
    if (completed.has(key)) return completed.get(key);
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(operation).then(result => {
      completed.set(key, result);
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
// Для долгоживущих процессов нужно ограничивать размер completed; для нескольких инстансов — общее хранилище.
