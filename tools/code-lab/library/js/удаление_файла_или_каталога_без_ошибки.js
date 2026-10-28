import { rm } from "node:fs/promises";

await rm("./временные", { recursive: true, force: true });
console.log("Очищено");
