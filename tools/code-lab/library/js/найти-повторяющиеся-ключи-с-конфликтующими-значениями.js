function findConflicts(items, keyFn, valueFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].filter(([, group]) => new Set(group.map(valueFn)).size > 1)
    .map(([key, records]) => ({ key, records }));
}
console.log(findConflicts([{id:1, price:10},{id:1, price:12}], x => x.id, x => x.price));
