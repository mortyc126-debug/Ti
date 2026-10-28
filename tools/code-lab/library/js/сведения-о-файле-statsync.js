const { statSync } = require("node:fs");

const fileInfo = statSync(__filename);
console.log(fileInfo.isFile(), fileInfo.isDirectory(), fileInfo.size > 0);

console.log(statSync(__dirname).isDirectory());
console.log(statSync("/нет/такого/файла", { throwIfNoEntry: false }));
