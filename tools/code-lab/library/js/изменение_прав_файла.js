import { chmod } from "node:fs/promises";
await chmod("./файл.txt", 0o644);
