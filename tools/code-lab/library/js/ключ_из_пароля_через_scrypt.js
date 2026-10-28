import { scrypt, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const соль = randomBytes(16);
const ключ = await promisify(scrypt)("пароль", соль, 64);

console.log(ключ.length);
