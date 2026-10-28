const данные = new TextEncoder().encode("привет");
const хеш = await crypto.subtle.digest("SHA-256", данные);

console.log(хеш.byteLength);
console.log(new Uint8Array(хеш)[0]);
