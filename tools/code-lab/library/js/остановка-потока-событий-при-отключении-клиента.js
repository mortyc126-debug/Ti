const http = require("node:http");

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/event-stream" });

  let counter = 0;
  const timer = setInterval(() => response.write(`data: ${++counter}\n\n`), 50);

  request.on("close", () => {
    clearInterval(timer);
    console.log("Клиент отключился, поток остановлен");
  });
});

server.listen(0, async () => {
  const controller = new AbortController();
  const reply = await fetch(`http://localhost:${server.address().port}`, {
    signal: controller.signal,
  });
  const reader = reply.body.getReader();
  const decoder = new TextDecoder();

  for (let step = 0; step < 2; step++) {
    const { value } = await reader.read();
    console.log("Получено:", decoder.decode(value).trim());
  }

  controller.abort();
  setTimeout(() => server.close(), 100);
});
