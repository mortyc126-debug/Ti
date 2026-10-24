const http = require('http');

http.createServer((req, res) => {
  if (req.url === '/api/hello') {
    res.end('hello');
  } else {
    res.statusCode = 404;
    res.end('Не найдено');
  }
}).listen(3000);