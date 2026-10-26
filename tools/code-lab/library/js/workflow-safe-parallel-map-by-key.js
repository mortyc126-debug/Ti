async function mapAsyncByKey(items, keyFn, mapper) {
  const pairs = await Promise.all(items.map(async (item, index) => [keyFn(item, index), await mapper(item, index)]));
  return new Map(pairs);
}
// const recordsById = await mapAsyncByKey(ids, id => id, id => loadRecord(id));
