console.log(new Number(5).valueOf());
console.log(new Date(0).valueOf());
const деньги = { сумма: 100, valueOf() { return this.сумма; } };
console.log(деньги + 50);
console.log(деньги > 80);
