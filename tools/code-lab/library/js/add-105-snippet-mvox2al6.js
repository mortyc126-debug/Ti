async function inBatches(items, limit, task) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...await Promise.all(items.slice(i, i + limit).map(task)));
  }
  return out;
}
// await inBatches(ids, 4, loadById)
