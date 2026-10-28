async function* сообщения() {
  yield "первое";
  yield "второе";
}

const итератор = сообщения();
const { value: сообщение, done: закончено } = await итератор.next();

console.log(сообщение, закончено);
