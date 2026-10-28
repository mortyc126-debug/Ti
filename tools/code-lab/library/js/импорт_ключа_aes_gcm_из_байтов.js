const байтыКлюча = crypto.getRandomValues(new Uint8Array(32));

const ключ = await crypto.subtle.importKey(
  "raw",
  байтыКлюча,
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"]
);

console.log(ключ.algorithm.name, ключ.extractable);
