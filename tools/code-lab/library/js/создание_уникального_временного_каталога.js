import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const каталог = await mkdtemp(path.join(os.tmpdir(), "app-"));
console.log(каталог.startsWith(os.tmpdir()));

await rm(каталог, { recursive: true });
