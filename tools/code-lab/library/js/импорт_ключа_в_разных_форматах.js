const исходный = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
const jwk = await crypto.subtle.exportKey("jwk", исходный);

const восстановленный = await crypto.subtle.importKey("jwk", jwk, { name: "AES-GCM" }, true, ["encrypt"]);

console.log(восстановленный.algorithm.name, восстановленный.extractable);
