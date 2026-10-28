import { execFile } from "node:child_process";
import { promisify } from "node:util";

const запуск = promisify(execFile);
const { stdout } = await запуск("node", ["--version"]);

console.log(stdout.trim());
