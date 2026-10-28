function считать() {
  let итог = 0;
  for (let i = 0; i < 1e6; i++) итог += i;
  return итог;
}

console.profile("расчёт");
считать();
console.profileEnd("расчёт");
