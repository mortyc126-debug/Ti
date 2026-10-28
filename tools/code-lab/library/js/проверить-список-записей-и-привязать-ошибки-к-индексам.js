function validateRows(rows, validateRow) {
  const errors = [];
  rows.forEach((row, index) => {
    const messages = validateRow(row);
    if (messages.length) errors.push({ index, row, errors: messages });
  });
  return { valid: errors.length === 0, errors };
}
console.log(validateRows([{id:1},{id:null}], row => row.id == null ? ['id обязателен'] : []));
