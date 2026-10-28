const rows = [{ id: 1, v: "a" }, { id: 1, v: "b" }, { id: 2, v: "c" }];
const unique = [...new Map(rows.map(row => [row.id, row])).values()];
console.log(unique);
