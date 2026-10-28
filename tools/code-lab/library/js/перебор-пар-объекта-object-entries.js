const prices = { хлеб: 45, молоко: 89, сыр: 320 };

for (const [name, price] of Object.entries(prices)) {
  console.log(`${name}: ${price} ₽`);
}
