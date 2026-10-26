function sortByKeys(items, rules) {
  return [...items].sort((a, b) => {
    for (const { key, direction = 1 } of rules) {
      const av = a[key], bv = b[key];
      if (av < bv) return -1 * direction;
      if (av > bv) return 1 * direction;
    }
    return 0;
  });
}
const result = sortByKeys([{name:'B', rank:1}, {name:'A', rank:1}, {name:'C', rank:2}], [{key:'rank'}, {key:'name'}]);
console.log(result);
