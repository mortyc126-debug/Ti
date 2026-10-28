function normalizeStringFields(record, fields) {
  const result = { ...record };
  for (const field of fields) {
    if (typeof result[field] === 'string') result[field] = result[field].trim().replace(/\s+/g, ' ');
  }
  return result;
}
console.log(normalizeStringFields({name:'  Anna   Lee ', code:4}, ['name']));
