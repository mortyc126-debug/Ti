function findDuplicateKeys(items, keyFn) {
  const seen = new Set(), duplicates = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  return [...duplicates];
}
console.log(findDuplicateKeys([{id:1},{id:2},{id:1}], x => x.id));
