const ключ = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const зашифрованное = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ключ, new TextEncoder().encode("секрет"));

const расшифрованное = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, ключ, зашифрованное);
console.log(new TextDecoder().decode(расшифрованное));
