async function* сообщения() {
  yield "первое";
  yield "второе";
}

const итератор = сообщения()[Symbol.asyncIterator]();

console.log(await итератор.next());
console.log(await итератор.next());
console.log(await итератор.next());
