async function processItemsIndividually(items, processItem) {
  const successes = [], failures = [];
  for (let index = 0; index < items.length; index++) {
    try { successes.push({ index, value: await processItem(items[index], index) }); }
    catch (error) { failures.push({ index, item: items[index], error }); }
  }
  return { successes, failures, ok: failures.length === 0 };
}
// const report = await processItemsIndividually(rows, saveRow);
