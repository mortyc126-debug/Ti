const обратныйОтсчёт = {
  значение: 3,
  [Symbol.iterator]() {
    return this;
  },
  next() {
    return this.значение > 0
      ? { value: this.значение--, done: false }
      : { value: undefined, done: true };
  },
};

console.log([...обратныйОтсчёт]);
console.log([...обратныйОтсчёт]);
