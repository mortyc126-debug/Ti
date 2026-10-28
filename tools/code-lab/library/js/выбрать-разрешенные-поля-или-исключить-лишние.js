function pick(source, keys) {
  return Object.fromEntries(keys.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]));
}
function omit(source, keysToRemove) {
  const excluded = new Set(keysToRemove);
  return Object.fromEntries(Object.entries(source).filter(([key]) => !excluded.has(key)));
}
console.log(pick({id:1, name:'A', secret:'x'}, ['id','name']));
