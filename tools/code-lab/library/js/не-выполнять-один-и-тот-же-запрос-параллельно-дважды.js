function createSingleFlight() {
  const pending = new Map();
  return function run(key, task) {
    if (pending.has(key)) return pending.get(key);
    const promise = Promise.resolve().then(task).finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };
}
const singleFlight = createSingleFlight();
// const a = singleFlight('prices', () => fetchPrices());
// const b = singleFlight('prices', () => fetchPrices()); // использует тот же Promise
