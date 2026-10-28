const path = require("node:path");
const file = "/home/анна/документы/отчёт.txt";
console.log(path.dirname(file));
console.log(path.dirname(path.dirname(file)));
