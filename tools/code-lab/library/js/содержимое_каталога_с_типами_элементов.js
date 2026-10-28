import { readdir } from "node:fs/promises";

const записи = await readdir(".", { withFileTypes: true });

for (const запись of записи) {
  console.log(запись.name, запись.isDirectory() ? "каталог" : "файл");
}
