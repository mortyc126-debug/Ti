function queryCollection(items, { predicate = () => true, key, direction = 1, page = 1, pageSize = 20 } = {}) {
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1) throw new RangeError('Некорректные page/pageSize');
  let result = items.filter(predicate);
  if (key) result = [...result].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * direction);
  const total = result.length;
  return { items: result.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages: Math.ceil(total / pageSize) };
}
console.log(queryCollection([{n:3},{n:1},{n:2}], {key:'n', page:1, pageSize:2}));
