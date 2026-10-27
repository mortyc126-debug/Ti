import { createServer } from "node:http";
import { once } from "node:events";

const сервер = createServer((запрос, ответ) => ответ.end("привет"));
сервер.listen(0);
await once(сервер, "listening");

console.log("Порт:", сервер.address().port);
сервер.close();