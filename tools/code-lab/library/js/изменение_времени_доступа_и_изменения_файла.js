import { utimes, stat } from "node:fs/promises";

const дата = new Date("2026-01-01T00:00:00Z");
await utimes("./отчёт.txt", дата, дата);

const сведения = await stat("./отчёт.txt");
console.log(сведения.mtime.toISOString());
