const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function pollUntil(check, { intervalMs = 500, timeoutMs = 10000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error('Истекло время ожидания условия');
}
// const job = await pollUntil(() => fetchJobStatus());
