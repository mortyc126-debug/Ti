import { realpath } from "node:fs/promises";

const настоящий = await realpath("./ссылка-на-конфиг/../config.json");
console.log(настоящий);
