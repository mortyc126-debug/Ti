function* считать() {
  yield 1;
  yield 2;
}

const итератор = считать();

console.log(итератор.next());
console.log(итератор[Symbol.iterator]() === итератор);
