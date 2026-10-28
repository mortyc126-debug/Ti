import { access } from "node:fs/promises";

const существует = await access("./отсутствует.txt").then(() => true, () => false);

console.log(существует);
