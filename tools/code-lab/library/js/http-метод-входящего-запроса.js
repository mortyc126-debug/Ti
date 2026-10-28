const http = require("node:http");

const server = http.createServer((request, response) => {
  if (request.method === "GET") {
    response.end("читаем");
  } else if (request.method === "POST") {
    response.end("создаём");
  } else {
    response.statusCode = 405;
    response.end("метод не поддерживается");
  }
});

function send(method, port) {
  return new Promise(resolve => {
    http.request({ port, method }, reply => {
      let body = "";
      reply.on("data", chunk => (body += chunk));
      reply.on("end", () => resolve(`${method}: ${reply.statusCode} ${body}`));
    }).end();
  });
}

server.listen(0, async () => {
  const { port } = server.address();
  for (const method of ["GET", "POST", "DELETE"]) {
    console.log(await send(method, port));
  }
  server.close();
});
