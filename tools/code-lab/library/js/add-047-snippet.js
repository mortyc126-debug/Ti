function pageOf(items, page, size) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}
console.log(pageOf(["a", "b", "c", "d"], 2, 2));
