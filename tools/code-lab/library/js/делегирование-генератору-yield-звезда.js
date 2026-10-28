function* evenNumbers(limit) {
  for (let number = 0; number <= limit; number += 2) {
    yield number;
  }
}

function* sequence() {
  yield "старт";
  yield* evenNumbers(6);
  yield* ["a", "b"];
  yield "финиш";
}

console.log([...sequence()]);
