const counter = {
  count: 0,
  increment: function () {
    this.count += 1;
    return this.count;
  },
  readWithArrow: () => this.count,
};

console.log(counter.increment());
console.log(counter.increment());
console.log(counter.readWithArrow());
