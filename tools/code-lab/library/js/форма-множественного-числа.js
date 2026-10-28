const locale = "ru";
const правила = new Intl.PluralRules(locale);
const формы = { one: "товар", few: "товара", many: "товаров", other: "товара" };
for (const count of [1, 2, 5, 21]) {
  console.log(count, формы[правила.select(count)]);
}
