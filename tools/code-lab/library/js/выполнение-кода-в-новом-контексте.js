const vm = require("node:vm");

const formula = "price * quantity * (1 - discount)";
const orderData = { price: 250, quantity: 3, discount: 0.1 };

console.log(vm.runInNewContext(formula, orderData, { timeout: 100 }));
console.log(vm.runInNewContext("typeof process", {}));
