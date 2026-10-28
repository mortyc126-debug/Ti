import { createServer } from "node:http";

const сервер = createServer(async (запрос, ответ) => {
  const части = [];
  for await (const часть of запрос) части.push(часть);
  try {
    const тело = JSON.parse(Buffer.concat(части).toString());
    ответ.end(`Получено: ${тело.имя}`);
  } catch {
    ответ.statusCode = 400;
    ответ.end("Некорректный JSON");
  }
});

await new Promise(готово => сервер.listen(0, готово));
const { port } = сервер.address();

const ответ = await fetch(`http://localhost:${port}`, {
  method: "POST",
  body: JSON.stringify({ имя: "Мира" }),
});
console.log(await ответ.text());

сервер.closeAllConnections();
сервер.close();
