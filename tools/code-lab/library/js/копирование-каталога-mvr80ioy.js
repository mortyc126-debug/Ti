import { cp } from "node:fs/promises";
await cp("./каталог", "./копия", { recursive: true });