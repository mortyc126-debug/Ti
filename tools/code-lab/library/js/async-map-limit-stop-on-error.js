async function mapLimitFailFast(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit должен быть >= 1');
  const results = new Array(items.length);
  let next = 0, failed = false, firstError;
  async function worker() {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await mapper(items[index], index); }
      catch (error) { if (!failed) { failed = true; firstError = error; } return; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw firstError;
  return results;
}
// Уже запущенные mapper нельзя автоматически отменить без AbortSignal.
