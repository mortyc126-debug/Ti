import { mkdir } from "node:fs/promises";

const путь = "./отчёты/2026/октябрь";
const созданный = await mkdir(путь, { recursive: true });
console.log(созданный);
