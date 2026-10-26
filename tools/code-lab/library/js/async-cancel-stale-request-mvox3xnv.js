function createLatestOnly() {
  let latest = 0;
  return async function run(task, applyResult) {
    const requestId = ++latest;
    const result = await task();
    if (requestId !== latest) return { applied: false, result };
    applyResult(result);
    return { applied: true, result };
  };
}
const runLatest = createLatestOnly();
// runLatest(() => search(query), renderResults);
