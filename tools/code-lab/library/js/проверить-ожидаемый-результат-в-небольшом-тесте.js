function assertDeepEqual(actual, expected, label = 'assertDeepEqual') {
  const normalize = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(normalize) : Object.fromEntries(Object.keys(value).sort().map(k => [k, normalize(value[k])]))
    : value;
  if (JSON.stringify(normalize(actual)) !== JSON.stringify(normalize(expected))) {
    throw new Error(`${label}: результат не совпал с ожиданием`);
  }
}
assertDeepEqual({b:2, a:1}, {a:1, b:2});
