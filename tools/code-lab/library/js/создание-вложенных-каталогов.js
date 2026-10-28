const fs = require("node:fs");
const os = require("node:os");
const модульПути = require("node:path");

const корень = fs.mkdtempSync(модульПути.join(os.tmpdir(), "проект-"));
const path = модульПути.join(корень, "данные", "отчёты", "архив");
fs.mkdirSync(path, { recursive: true });
console.log(fs.existsSync(path));
fs.rmSync(корень, { recursive: true });
