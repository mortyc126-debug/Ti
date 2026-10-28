const http = require("node:http");

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.end("обычный текст");
});

server.listen(0, () => {
  const options = { port: server.address().port, headers: { Origin: "https://app.example.com" } };
  http.get(options, reply => {
    console.log(reply.headers["x-content-type-options"]);
    reply.resume();
    reply.on("end", () => server.close());
  });
});
