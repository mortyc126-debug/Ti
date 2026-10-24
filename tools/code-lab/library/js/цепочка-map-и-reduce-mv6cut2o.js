const items = [
  { price: 10, quantity: 2 },
  { price: 7, quantity: 3 },
  { price: 5, quantity: 1 }
];

const totals = items.map(item => item.price * item.quantity);
const grandTotal = totals.reduce((sum, value) => sum + value, 0);

console.log(totals);
console.log(grandTotal);