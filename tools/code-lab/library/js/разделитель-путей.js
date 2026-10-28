const path = require("node:path");
console.log(path.sep === "/" || path.sep === "\\");
const части = ["данные", "отчёты", "итог.txt"].join(path.sep);
console.log(части.split(path.sep));
