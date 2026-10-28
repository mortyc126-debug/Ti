function emptyStringsToNull(record, fields) {
  const next = { ...record };
  for (const field of fields) if (typeof next[field] === 'string' && next[field].trim() === '') next[field] = null;
  return next;
}
console.log(emptyStringsToNull({name:'  ', code:'A'}, ['name','code']));
