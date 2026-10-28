const имена = ["Ёлка", "Арбуз", "Банан"];
имена.sort((a, b) => a.localeCompare(b, "ru"));
console.log(имена);
