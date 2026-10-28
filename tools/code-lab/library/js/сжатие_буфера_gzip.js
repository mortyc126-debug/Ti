import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const исходный = Buffer.from("а".repeat(1000));
const сжатый = await promisify(gzip)(исходный);
const восстановленный = await promisify(gunzip)(сжатый);

console.log(сжатый.length < исходный.length);
console.log(восстановленный.equals(исходный));
