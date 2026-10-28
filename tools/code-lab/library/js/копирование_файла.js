import { copyFile } from "node:fs/promises";
await copyFile("./источник.txt", "./копия.txt");
