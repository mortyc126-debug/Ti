import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

createServer(async (запрос, ответ) => {
  ответ.setHeader("Content-Type", "text/plain; charset=utf-8");
  try {
    await pipeline(createReadStream("./отчёт.txt"), ответ);
  } catch {
    ответ.destroy();
  }
}).listen(3000);