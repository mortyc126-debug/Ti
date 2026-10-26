function diffById(before, after) {
  const oldMap = new Map(before.map(item => [item.id, item]));
  const newMap = new Map(after.map(item => [item.id, item]));
  const added = [], removed = [], changed = [];
  for (const [id, next] of newMap) {
    if (!oldMap.has(id)) added.push(next);
    else if (JSON.stringify(oldMap.get(id)) !== JSON.stringify(next)) changed.push({ before: oldMap.get(id), after: next });
  }
  for (const [id, prev] of oldMap) if (!newMap.has(id)) removed.push(prev);
  return { added, removed, changed };
}
console.log(diffById([{id:1, v:1}], [{id:1, v:2}, {id:2, v:1}]));
