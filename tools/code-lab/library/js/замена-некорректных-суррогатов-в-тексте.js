const input = "Имя: Мира\uDC00";
const cleaned = input.toWellFormed();

console.log(cleaned === input);
console.log(cleaned.includes("\uFFFD"));
console.log(input.isWellFormed(), cleaned.isWellFormed());
