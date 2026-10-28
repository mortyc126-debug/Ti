class Counter {
  count = 0;

  increment() {
    this.count += 1;
    return this.count;
  }
}

const counter = new Counter();
console.log(counter.increment());

const { increment } = counter;
try {
  increment();
} catch (error) {
  console.log("Потерян this:", error.name);
}

const bound = counter.increment.bind(counter);
console.log(bound());
