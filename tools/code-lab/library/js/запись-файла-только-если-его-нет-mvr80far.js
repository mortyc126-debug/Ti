import { writeFile } from "node:fs/promises";

try {
  await writeFile("./настройки.json", "{}", { flag: "wx" });
  console.log("Создан");
} catch (ошибка) {
  console.log(ошибка.code);
}