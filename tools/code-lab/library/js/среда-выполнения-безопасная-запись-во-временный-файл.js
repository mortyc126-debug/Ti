import { writeFile, rename } from "node:fs/promises";
const temp = "./settings.json.tmp";
await writeFile(temp, JSON.stringify({ version: 1 }), "utf8");
await rename(temp, "./settings.json");
