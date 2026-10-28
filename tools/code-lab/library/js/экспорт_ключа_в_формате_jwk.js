const ключ = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const экспорт = await crypto.subtle.exportKey("jwk", ключ);

console.log(экспорт.kty, экспорт.alg);
