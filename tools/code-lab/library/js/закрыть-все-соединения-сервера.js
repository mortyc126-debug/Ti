const http = require("node:http");

const server = http.createServer((request, response) => {
  response.writeHead(200);
  response.write("часть ответа");
});

server.listen(0, () => {
  const incoming = http.get({ port: server.address().port }, reply => {
    reply.on("data", chunk => console.log("Получено:", chunk.toString()));
    reply.on("error", () => console.log("Соединение разорвано"));
    reply.on("close", () => console.log("Ответ закрыт"));
  });
  incoming.on("error", () => {});

  setTimeout(() => {
    server.close(() => console.log("Сервер остановлен"));
    server.closeAllConnections();
  }, 100);
});
