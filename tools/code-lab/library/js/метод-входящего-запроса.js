const http = require("node:http");
const server = http.createServer((request, response) => {
  response.end(request.method);
});
server.listen(0, async () => {
  const { port } = server.address();
  const ответ = await fetch(`http://127.0.0.1:${port}`, { method: "POST" });
  console.log(await ответ.text());
  server.close();
});
