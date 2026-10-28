const http = require("node:http");

const server = http.createServer((request, response) => {
  response.setHeader("content-security-policy", "default-src 'self'");
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<h1>Привет</h1>");
});

server.listen(0, () => {
  const options = { port: server.address().port, headers: { Origin: "https://app.example.com" } };
  http.get(options, reply => {
    console.log(reply.headers["content-security-policy"]);
    reply.resume();
    reply.on("end", () => server.close());
  });
});
