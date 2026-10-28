let balance = 1000;
let years = 0;

while (balance < 2000) {
  balance *= 1.07;
  years += 1;
}

console.log(`Вклад удвоится через ${years} лет`);
