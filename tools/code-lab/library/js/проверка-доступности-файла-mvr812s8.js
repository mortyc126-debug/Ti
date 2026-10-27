import { access } from "node:fs/promises";
try { await access("./package.json"); console.log("Доступен"); }
catch { console.log("Недоступен"); }