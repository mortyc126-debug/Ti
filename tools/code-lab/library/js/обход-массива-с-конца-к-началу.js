const numbers = [1, 2, 3, 4, 5, 6];

for (let i = numbers.length - 1; i >= 0; i--) {
  if (numbers[i] % 2 === 0) numbers.splice(i, 1);
}

console.log(numbers.join(", "));
