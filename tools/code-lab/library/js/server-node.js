import http from "node:http";

const сервер = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Привет!");
});

сервер.listen(8788, () => console.log("http://localhost:8788/"));