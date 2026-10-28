function getDomain(address) {
  const link = new URL(address);
  return link.hostname;
}

console.log(getDomain("https://shop.example.com:8080/catalog?page=2"));
console.log(getDomain("http://localhost:3000/api"));
