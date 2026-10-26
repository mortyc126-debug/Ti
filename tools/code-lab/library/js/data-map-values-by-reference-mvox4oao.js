function entriesToRecords(source, keyField = 'key', valueField = 'value') {
  return Object.entries(source).map(([key, value]) => ({ [keyField]: key, [valueField]: value }));
}
console.log(entriesToRecords({a:1,b:2}));
