function returnsFromPrices(prices) {
  const out = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    out.push(prev > 0 ? prices[i] / prev - 1 : null);
  }
  return out;
}
console.log(returnsFromPrices([100, 105, 99]));
