const цены = { чай: 120, кофе: 90, какао: 150 };

const дорогие = Object.fromEntries(
  Object.entries(цены).filter(([название, цена]) => цена > 100)
);

console.log(дорогие);
