const счётчики = new Map();
for (const имя of ["A", "B", "A"]) {
  счётчики.set(имя, (счётчики.get(имя) ?? 0) + 1);
}
console.log(счётчики);
