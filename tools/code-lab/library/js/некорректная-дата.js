const date = new Date("не дата");
console.log(Number.isNaN(date.getTime()));
console.log(Number.isNaN(new Date(Date.UTC(2024, 0, 1)).getTime()));
