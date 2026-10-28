const строка = "1, Мира , 30";
const ячейки = строка.split(",").map(ячейка => ячейка.trim());

console.log(ячейки);
