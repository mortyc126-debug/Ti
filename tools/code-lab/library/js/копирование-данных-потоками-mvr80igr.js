import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

try {
  await pipeline(
    createReadStream("./видео.mp4"),
    createWriteStream("./копия.mp4")
  );
  console.log("Скопировано");
} catch (ошибка) {
  console.error("Сбой копирования:", ошибка.message);
}