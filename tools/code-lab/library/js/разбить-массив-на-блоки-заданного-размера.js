function chunk(items, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size должен быть целым числом больше нуля');
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}
console.log(chunk([1,2,3,4,5], 2));
