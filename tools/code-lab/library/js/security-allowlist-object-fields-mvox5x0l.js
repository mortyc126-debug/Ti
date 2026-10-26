function allowFields(input, allowedFields) {
  const result = {};
  for (const key of allowedFields) {
    if (Object.hasOwn(input, key)) result[key] = input[key];
  }
  return result;
}
console.log(allowFields({name:'A', role:'admin'}, ['name']));
