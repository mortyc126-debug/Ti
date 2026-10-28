const { writeFileSync, readFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const filePath = path.join(os.tmpdir(), "settings-demo.json");
const settings = { theme: "dark", fontSize: 14 };

writeFileSync(filePath, JSON.stringify(settings, null, 2));

console.log(readFileSync(filePath, "utf8"));
