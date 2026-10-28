async function processWithCheckpoint(items, { batchSize, startAt = 0, processBatch, saveCheckpoint }) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('batchSize должен быть >= 1');
  let completed = startAt;
  for (let start = startAt; start < items.length; start += batchSize) {
    const end = Math.min(items.length, start + batchSize);
    await processBatch(items.slice(start, end), { start, end });
    completed = end;
    await saveCheckpoint(completed);
  }
  return { completed };
}
// saveCheckpoint должен быть надёжным хранилищем прогресса; повторная обработка пакета должна быть безопасной.
