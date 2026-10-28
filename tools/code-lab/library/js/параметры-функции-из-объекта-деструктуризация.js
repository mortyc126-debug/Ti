function connect({ host, port = 3000, secure = false }) {
  return `${secure ? "https" : "http"}://${host}:${port}`;
}

console.log(connect({ host: "localhost" }));
console.log(connect({ host: "example.com", port: 443, secure: true }));
