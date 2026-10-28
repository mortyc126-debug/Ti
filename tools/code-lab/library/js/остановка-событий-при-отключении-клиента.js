const http = require("node:http");
const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const timer = setInterval(() => response.write("data: тик\n\n"), 10);
  request.on("close", () => clearInterval(timer));
  request.on("close", () => {
    console.log("клиент отключился");
    server.close();
  });
});
server.listen(0, () => {
  const { port } = server.address();
  const запрос = http.get(`http://127.0.0.1:${port}`, ответ => {
    ответ.once("data", () => {
      console.log("получено первое событие");
      запрос.destroy();
    });
  });
  запрос.on("error", () => {});
});
