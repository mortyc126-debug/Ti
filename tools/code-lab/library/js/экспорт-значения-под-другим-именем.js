function calculateTotal(prices) {
  return prices.reduce((sum, price) => sum + price, 0);
}

export { calculateTotal as total };

console.log(calculateTotal([100, 250, 50]));
