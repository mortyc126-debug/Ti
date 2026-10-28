function normalizeById(items) {
  const entities = Object.create(null), ids = [];
  for (const item of items) {
    if (Object.hasOwn(entities, item.id)) throw new Error(`Повторяющийся id: ${item.id}`);
    entities[item.id] = item;
    ids.push(item.id);
  }
  return { ids, entities };
}
console.log(normalizeById([{id:'a',v:1},{id:'b',v:2}]));
