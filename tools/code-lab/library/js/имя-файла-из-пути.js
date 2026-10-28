const path = require("node:path");
const file = "/home/анна/отчёт.txt";
console.log(path.basename(file));
console.log(path.basename(file, ".txt"));
