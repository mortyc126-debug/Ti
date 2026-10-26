const names = ["Ёлка", "Анна", "Борис"];
names.sort((a, b) => a.localeCompare(b, "ru"));
console.log(names);
