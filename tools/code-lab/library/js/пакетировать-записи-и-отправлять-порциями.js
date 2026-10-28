async function processInBatches(items, batchSize, processBatch) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize должен быть >= 1');
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    results.push(await processBatch(items.slice(i, i + batchSize), i / batchSize));
  }
  return results;
}
// const responses = await processInBatches(records, 100, batch => api.saveMany(batch));
