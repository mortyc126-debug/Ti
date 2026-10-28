const os = require("node:os");
const потоки = os.availableParallelism();
console.log(Number.isInteger(потоки));
console.log(потоки >= 1);
