const http = require("node:http");

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ message: "Привет" }));
});

server.listen(0, () => {
  const options = { port: server.address().port, headers: { Origin: "https://app.example.com" } };
  http.get(options, reply => {
    console.log(reply.headers["content-type"]);
    reply.resume();
    reply.on("end", () => server.close());
  });
});
