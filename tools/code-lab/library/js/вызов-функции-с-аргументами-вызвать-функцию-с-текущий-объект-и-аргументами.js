function сумма(a, b) { return this.база + a + b; }
console.log(Reflect.apply(сумма, { база: 10 }, [2, 3]));
