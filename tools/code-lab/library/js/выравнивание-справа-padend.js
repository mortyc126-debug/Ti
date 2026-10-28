const products = [
  { name: "Хлеб", price: 45 },
  { name: "Молоко", price: 89 },
  { name: "Сыр", price: 320 },
];

for (const product of products) {
  console.log(`${product.name.padEnd(8, " ")}${product.price} ₽`);
}
