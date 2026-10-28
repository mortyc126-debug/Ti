function joinBy(left, right, key) {
  const rightByKey = new Map(right.map(item => [item[key], item]));
  return left.map(item => {
    const match = rightByKey.get(item[key]);
    return match ? { ...item, ...match } : { ...item };
  });
}
console.log(joinBy([{id:1, name:'A'}], [{id:1, score:9}], 'id'));
