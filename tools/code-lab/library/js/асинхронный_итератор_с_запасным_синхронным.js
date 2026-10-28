const получитьИтератор = источник =>
  источник[Symbol.asyncIterator]?.() ?? источник[Symbol.iterator]();

async function* поток() {
  yield "из потока";
}

console.log(await получитьИтератор(поток()).next());
console.log(await получитьИтератор(["из массива"]).next());
