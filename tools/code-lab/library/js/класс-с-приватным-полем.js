class Counter {
  #value = 0;
  increment() { this.#value++; }
  get value() { return this.#value; }
}
const counter = new Counter();
counter.increment();
console.log(counter.value);
