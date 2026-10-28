function getPath(source, path, fallback) {
  let value = source;
  for (const key of path) {
    if (value == null || !Object.hasOwn(Object(value), key)) return fallback;
    value = value[key];
  }
  return value === undefined ? fallback : value;
}
console.log(getPath({a:{b:0}}, ['a','b'], 10));
