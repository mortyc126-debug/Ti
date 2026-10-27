import { createServer } from "node:http";

const сервер = createServer((запрос, ответ) => ответ.end("ок"));
await new Promise(разрешить => сервер.listen(3000, разрешить));
console.log("Сервер запущен");

await new Promise(разрешить => сервер.close(разрешить));
console.log("Сервер остановлен");