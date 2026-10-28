const диапазон = {
  от: 1,
  до: 3,
  [Symbol.iterator]() {
    let текущее = this.от;
    const конец = this.до;
    return {
      next: () =>
        текущее <= конец
          ? { value: текущее++, done: false }
          : { value: undefined, done: true },
    };
  },
};

console.log([...диапазон]);
console.log([...диапазон]);
