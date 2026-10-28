import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
console.log(path.join(__dirname, "данные", "config.json"));
