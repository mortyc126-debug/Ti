function toggleSelection(selectedIds, id) {
  const next = new Set(selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
console.log([...toggleSelection(new Set([1,2]), 2)]);
