const stock = new Map([
  ["яблоки", 12],
  ["груши", 5],
  ["сливы", 0],
]);

for (const [name, count] of stock) {
  console.log(`${name}: ${count}`);
}
