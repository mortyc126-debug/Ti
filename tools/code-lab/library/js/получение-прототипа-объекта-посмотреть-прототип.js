const родитель = { тип: "базовый" };
const потомок = Object.create(родитель);
console.log(Object.getPrototypeOf(потомок) === родитель);
