const numbers = [3, 8, 15, 22, 7];
let firstEven;

for (const number of numbers) {
  if (number % 2 === 0) {
    firstEven = number;
    break;
  }
}

console.log(firstEven);
