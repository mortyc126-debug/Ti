const os = require("node:os");
const путь = require("node:path");
const временный = os.tmpdir();
console.log(путь.isAbsolute(временный));
console.log(путь.join(временный, "файл.tmp").endsWith("файл.tmp"));
