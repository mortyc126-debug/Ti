const fs = require("node:fs");
const os = require("node:os");
const модульПути = require("node:path");

const path = fs.mkdtempSync(модульПути.join(os.tmpdir(), "каталог-"));
fs.writeFileSync(модульПути.join(path, "б.txt"), "второй");
fs.writeFileSync(модульПути.join(path, "а.txt"), "первый");

console.log(fs.readdirSync(path).sort());
fs.rmSync(path, { recursive: true });
