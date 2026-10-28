function isSecureLink(address) {
  try {
    return new URL(address).protocol === "https:";
  } catch {
    return false;
  }
}

console.log(isSecureLink("https://example.com"));
console.log(isSecureLink("http://example.com"));
console.log(isSecureLink("это не ссылка"));
