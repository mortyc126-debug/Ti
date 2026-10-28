const http = require("node:http");

const server = http.createServer((request, response) => {
  const trustedOrigins = ["https://app.example.com", "https://admin.example.com"];
  const origin = request.headers.origin;

  if (trustedOrigins.includes(origin)) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
  }
  response.end("ok");
});

server.listen(0, () => {
  const options = { port: server.address().port, headers: { Origin: "https://app.example.com" } };
  http.get(options, reply => {
    console.log(reply.headers["access-control-allow-origin"]);
    reply.resume();
    reply.on("end", () => server.close());
  });
});
