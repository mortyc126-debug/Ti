import { truncate, stat } from "node:fs/promises";

await truncate("./журнал.log", 100);
const сведения = await stat("./журнал.log");
console.log(сведения.size);