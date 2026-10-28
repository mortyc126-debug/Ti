function* числа() {
  yield 1;
  yield 2;
}

const итератор = числа();
let шаг = итератор.next();

while (!шаг.done) {
  console.log(шаг.value);
  шаг = итератор.next();
}
