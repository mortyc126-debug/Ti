const квадрат = (x) => x * x;
const сумма = (a, b) => a + b;
const метка = () => ({ ok: true });

console.log([1, 2, 3].map(квадрат));
console.log(сумма(2, 3), метка());