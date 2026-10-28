import { timingSafeEqual } from "node:crypto";

const полученный = Buffer.from("токен-1");
const ожидаемый = Buffer.from("токен-1");

const равны = полученный.length === ожидаемый.length && timingSafeEqual(полученный, ожидаемый);
console.log(равны);
