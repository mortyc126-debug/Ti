const http = require('http');

http.createServer((req, res) => {
  const data = { name: 'Анна', age: 31 };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}).listen(3000);