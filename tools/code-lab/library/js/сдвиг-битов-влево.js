const levels = [1, 5, 12, 100];

for (const level of levels) {
  console.log(`${level} << 1 = ${level << 1}`);
}

console.log(`2**30 << 1 = ${2 ** 30 << 1}`);
