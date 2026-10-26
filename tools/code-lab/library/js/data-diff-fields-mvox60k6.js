function diffFields(before, after, fields) {
  return Object.fromEntries(fields.filter(key => !Object.is(before[key], after[key]))
    .map(key => [key, { before: before[key], after: after[key] }]));
}
console.log(diffFields({a:1,b:2}, {a:1,b:3}, ['a','b']));
