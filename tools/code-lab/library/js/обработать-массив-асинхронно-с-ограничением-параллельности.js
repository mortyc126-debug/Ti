async function mapLimit(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit должен быть >= 1');
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
// const results = await mapLimit(ids, 4, id => loadRecord(id));
