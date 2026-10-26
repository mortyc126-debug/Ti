function partition(items, predicate) {
  const yes = [], no = [];
  for (const item of items) (predicate(item) ? yes : no).push(item);
  return { yes, no };
}
console.log(partition([1, 2, 3, 4], n => n % 2 === 0));
