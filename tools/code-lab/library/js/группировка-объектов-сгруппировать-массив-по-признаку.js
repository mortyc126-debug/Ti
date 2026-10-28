const сделки = [{ тип: "buy", id: 1 }, { тип: "sell", id: 2 }, { тип: "buy", id: 3 }];
const группы = Object.groupBy(сделки, сделка => сделка.тип);
console.log(группы.buy.length);
