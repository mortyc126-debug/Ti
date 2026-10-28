function createCounter() {
  let count = 0;
  return () => ++count;
}
const next = createCounter();
console.log(next(), next(), next());
