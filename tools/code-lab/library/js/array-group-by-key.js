function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}
const groups = groupBy([{type:'a', n:1}, {type:'b', n:2}, {type:'a', n:3}], x => x.type);
console.log([...groups]);
