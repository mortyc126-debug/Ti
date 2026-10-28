import { createReadStream, createWriteStream } from "node:fs";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const исходник = "./журнал.log";
const архив = "./журнал.log.gz";

await pipeline(createReadStream(исходник), createGzip(), createWriteStream(архив));
console.log("Сжато:", архив);
