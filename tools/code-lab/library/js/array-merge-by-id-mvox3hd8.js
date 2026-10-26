function mergeById(current, updates) {
  const updateMap = new Map(updates.map(item => [item.id, item]));
  const seen = new Set();
  const result = current.map(item => {
    if (!updateMap.has(item.id)) return item;
    seen.add(item.id);
    return { ...item, ...updateMap.get(item.id) };
  });
  for (const item of updates) if (!seen.has(item.id)) result.push(item);
  return result;
}
console.log(mergeById([{id:1, x:1}], [{id:1, y:2}, {id:2, x:3}]));
