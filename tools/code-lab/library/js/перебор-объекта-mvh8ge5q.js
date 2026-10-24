const prices = { чай: 120, кофе: 200 };

for (const [name, price] of Object.entries(prices)) {
  console.log(name, price);
}