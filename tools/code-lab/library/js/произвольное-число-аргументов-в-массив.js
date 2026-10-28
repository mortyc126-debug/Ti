function fn(...args) {
  return args;
}

console.log(fn(1, 2, 3));
console.log(fn());

function sum(...numbers) {
  return numbers.reduce((total, number) => total + number, 0);
}

console.log(sum(4, 5, 6));
