import { unlink } from "node:fs/promises";

await unlink("./кэш/старый.tmp");
console.log("Файл удалён");
