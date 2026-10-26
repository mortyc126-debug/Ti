const rows = [{ id: 1, active: false }, { id: 2, active: false }];
const updated = rows.map(row => row.id === 2 ? { ...row, active: true } : row);
console.log(updated);
