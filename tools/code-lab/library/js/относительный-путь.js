const path = require("node:path");
const from = "/данные/отчёты";
const to = "/данные/архив/старое";
console.log(path.relative(from, to));
console.log(path.relative(to, from));
