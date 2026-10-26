const trades = [{ ticker: "SBER", qty: 2 }, { ticker: "VTBR", qty: 1 }, { ticker: "SBER", qty: 3 }];
const grouped = Map.groupBy(trades, trade => trade.ticker);
console.log(grouped.get("SBER").length);
