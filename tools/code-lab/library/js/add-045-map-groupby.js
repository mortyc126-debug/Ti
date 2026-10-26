const rows = [{ type: "A", n: 1 }, { type: "B", n: 2 }, { type: "A", n: 3 }];
const grouped = rows.reduce((acc, row) => {
  (acc[row.type] ??= []).push(row);
  return acc;
}, {});
console.log(grouped.A.length);
