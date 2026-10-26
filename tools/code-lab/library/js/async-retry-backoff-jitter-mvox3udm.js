const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(task, { attempts = 4, baseMs = 200, maxMs = 5000, shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await task(attempt); }
    catch (error) {
      lastError = error;
      if (attempt === attempts - 1 || !shouldRetry(error, attempt)) throw error;
      const cap = Math.min(maxMs, baseMs * 2 ** attempt);
      await sleep(Math.random() * cap);
    }
  }
  throw lastError;
}
// const data = await retry(() => request(), { shouldRetry: e => e.status >= 500 });
