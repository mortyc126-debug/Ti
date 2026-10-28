import { createCipheriv, randomBytes } from "node:crypto";

const ключ = randomBytes(32);
const iv = randomBytes(12);

const шифр = createCipheriv("aes-256-gcm", ключ, iv);
const зашифрованное = Buffer.concat([шифр.update("секретные данные", "utf8"), шифр.final()]);
const тег = шифр.getAuthTag();

console.log(зашифрованное.length, тег.length);
