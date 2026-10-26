function leftJoinBy(left, right, key) {
  const index = new Map(right.map(item => [item[key], item]));
  return left.map(item => ({ left: item, right: index.get(item[key]) ?? null }));
}
console.log(leftJoinBy([{id:1},{id:2}], [{id:2, value:'x'}], 'id'));
