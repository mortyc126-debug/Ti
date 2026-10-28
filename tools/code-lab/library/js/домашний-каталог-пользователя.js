const os = require("node:os");
const путь = require("node:path");
const домашний = os.homedir();
console.log(путь.isAbsolute(домашний));
console.log(typeof домашний);
