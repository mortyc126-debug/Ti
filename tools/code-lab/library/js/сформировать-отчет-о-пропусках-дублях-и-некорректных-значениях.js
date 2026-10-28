function dataQualityReport(rows, { required = [], validators = {}, uniqueBy = [] } = {}) {
  const missing = Object.fromEntries(required.map(field => [field, []]));
  const invalid = Object.fromEntries(Object.keys(validators).map(field => [field, []]));
  const seen = new Map(), duplicates = [];
  rows.forEach((row, index) => {
    for (const field of required) if (row[field] == null || row[field] === '') missing[field].push(index);
    for (const [field, validate] of Object.entries(validators)) if (!validate(row[field], row)) invalid[field].push(index);
    if (uniqueBy.length) {
      const key = JSON.stringify(uniqueBy.map(field => row[field]));
      if (seen.has(key)) duplicates.push({ index, firstIndex: seen.get(key), key }); else seen.set(key, index);
    }
  });
  return { rows: rows.length, missing, invalid, duplicates };
}
// dataQualityReport(rows, { required:['id'], validators:{price:Number.isFinite}, uniqueBy:['id'] });
