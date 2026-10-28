const path = require("node:path");
console.log(path.isAbsolute("/home/анна/отчёт.txt"));
console.log(path.isAbsolute("отчёт.txt"));
console.log(path.isAbsolute("./отчёт.txt"));
