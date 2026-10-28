function updateById(items, id, patch) {
  return items.map(item => item.id === id ? { ...item, ...patch } : item);
}
console.log(updateById([{id:1, active:false},{id:2, active:false}], 2, {active:true}));
