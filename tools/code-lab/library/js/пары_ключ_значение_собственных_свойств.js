const цены = { чай: 120, кофе: 90 };

for (const [название, цена] of Object.entries(цены)) {
  console.log(название, цена);
}
