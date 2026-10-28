const ключ = await crypto.subtle.generateKey(
  { name: "HMAC", hash: "SHA-256" },
  true,
  ["sign", "verify"]
);

console.log(ключ.type, ключ.algorithm.name);
