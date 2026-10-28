const http = require("node:http");
const server = http.createServer((request, response) => {
  response.end(request.headers["content-type"]);
});
server.listen(0, async () => {
  const { port } = server.address();
  const ответ = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  console.log(await ответ.text());
  server.close();
});
