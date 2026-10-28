const http = require("node:http");

const server = http.createServer((request, response) => {
  const contentType = request.headers["content-type"] ?? "не указан";
  response.end(`Тип тела: ${contentType}`);
});

server.listen(0, () => {
  const options = {
    port: server.address().port,
    method: "POST",
    headers: { "Content-Type": "application/json" },
  };
  const outgoing = http.request(options, reply => {
    reply.setEncoding("utf8");
    reply.on("data", text => console.log(text));
    reply.on("end", () => server.close());
  });
  outgoing.end("{}");
});
