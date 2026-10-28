async function получитьЗначение(номер) {
  await new Promise(пауза => setTimeout(пауза, 5));
  return номер * 10;
}

const источник = {
  async *[Symbol.asyncIterator]() {
    for (const номер of [1, 2]) {
      yield await получитьЗначение(номер);
    }
  },
};

for await (const результат of источник) {
  console.log(результат);
}
