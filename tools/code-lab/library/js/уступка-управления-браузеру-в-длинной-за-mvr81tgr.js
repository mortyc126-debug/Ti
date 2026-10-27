const элементы = Array.from({ length: 5000 }, (_, i) => i);
let сумма = 0;

for (const [номер, число] of элементы.entries()) {
  сумма += число;
  if (номер % 500 === 0 && globalThis.scheduler?.yield) {
    await scheduler.yield();
  }
}
console.log(сумма);