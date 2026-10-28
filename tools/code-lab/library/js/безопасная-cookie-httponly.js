const http = require("node:http");

const server = http.createServer((request, response) => {
  response.setHeader("set-cookie", "id=abc123; HttpOnly; Secure; SameSite=Lax; Path=/");
  response.end("ok");
});

server.listen(0, () => {
  const options = { port: server.address().port, headers: { Origin: "https://app.example.com" } };
  http.get(options, reply => {
    console.log(reply.headers["set-cookie"]);
    reply.resume();
    reply.on("end", () => server.close());
  });
});
