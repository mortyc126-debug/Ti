const path = require("node:path");
console.log(path.extname("/home/анна/отчёт.txt"));
console.log(path.extname("архив.tar.gz"));
console.log(path.extname("без-расширения") === "");
