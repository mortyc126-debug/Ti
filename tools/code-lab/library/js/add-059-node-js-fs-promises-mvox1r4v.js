import { readFile } from "node:fs/promises";
try {
  const text = await readFile("./data.txt", "utf8");
  console.log(text);
} catch (error) {
  console.error("Не удалось прочитать файл:", error.message);
}
