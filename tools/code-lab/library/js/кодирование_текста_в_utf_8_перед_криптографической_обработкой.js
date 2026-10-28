const закодированное = new TextEncoder().encode("пароль");

const материал = await crypto.subtle.importKey("raw", закодированное, "PBKDF2", false, ["deriveBits"]);
console.log(закодированное.byteLength, материал.type);
