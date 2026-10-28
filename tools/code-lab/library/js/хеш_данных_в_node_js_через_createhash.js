import { createHash } from "node:crypto";

const хеш = createHash("sha256").update("abc").digest("hex");

console.log(хеш);
