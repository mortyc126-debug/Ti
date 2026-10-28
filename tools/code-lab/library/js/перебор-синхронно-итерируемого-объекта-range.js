const range = {
  from: 1,
  to: 4,
  [Symbol.iterator]() {
    let current = this.from;
    const last = this.to;
    return {
      next: () => (current <= last ? { value: current++, done: false } : { value: undefined, done: true }),
    };
  },
};

for (const value of range) {
  console.log(value);
}
console.log([...range]);
