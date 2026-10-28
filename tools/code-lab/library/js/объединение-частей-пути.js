const path = require("node:path");
console.log(path.join("данные", "отчёты", "итог.txt"));
console.log(path.join("/данные", "../архив", "итог.txt"));
