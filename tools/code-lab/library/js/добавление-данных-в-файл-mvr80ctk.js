import { appendFile } from "node:fs/promises";
await appendFile("./журнал.txt", "Новая запись\n", "utf8");