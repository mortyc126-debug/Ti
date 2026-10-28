const { existsSync } = require("node:fs");

console.log(existsSync(__filename));
console.log(existsSync("/нет/такого/файла.txt"));
console.log(existsSync(__dirname));
