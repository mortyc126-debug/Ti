const path = require("node:path");
const каталог = process.cwd();
console.log(path.isAbsolute(каталог));
console.log(typeof каталог);
