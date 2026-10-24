const bonds = [
  { name: "Альфа", yield: 12.4, years: 2 },
  { name: "Бета", yield: 9.8, years: 1 },
  { name: "Гамма", yield: 13.1, years: 5 }
];

const shortlist = bonds
  .filter(bond => bond.yield >= 10 && bond.years <= 3)
  .sort((a, b) => b.yield - a.yield);

console.log(shortlist.map(bond => bond.name));