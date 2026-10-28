const сервер = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if(url.pathname === "/api/time"){
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ time: Date.now() }));
  }
  res.writeHead(404);
  res.end("not found");
});