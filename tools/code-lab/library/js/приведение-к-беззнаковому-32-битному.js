const numbers = [-1, 5, 2 ** 32 + 7, 3.9];

for (const number of numbers) {
  console.log(`${number} >>> 0 = ${number >>> 0}`);
}
