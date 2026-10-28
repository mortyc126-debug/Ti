const util = require("node:util");

const order = {
  id: 7,
  customer: {
    name: "Мира",
    address: { city: "Лиссабон", geo: { lat: 38.72, lon: -9.14 } },
  },
};

console.log(util.inspect(order, { depth: null, colors: true }));
