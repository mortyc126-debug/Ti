function calculateTotal(price, quantity) {
  return price * quantity;
}

const orders = [
  { price: 12, quantity: 2 },
  { price: 5, quantity: 4 },
  { price: 20, quantity: 1 }
];

const totals = orders.map(order =>
  calculateTotal(order.price, order.quantity)
);

console.log(totals);