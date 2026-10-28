const ключ = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const данные = new TextEncoder().encode("секрет");

const зашифрованное = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ключ, данные);
console.log(зашифрованное.byteLength);
