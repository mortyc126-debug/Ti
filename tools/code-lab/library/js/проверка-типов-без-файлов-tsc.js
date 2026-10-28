const { spawnSync } = require("node:child_process");

const result = spawnSync("npx", ["tsc", "--noEmit"], {
  encoding: "utf8",
  shell: process.platform === "win32",
});

if (result.status === 0) {
  console.log("Типы в порядке");
} else {
  console.log("Найдены ошибки типов:");
  console.log(result.stdout || result.stderr);
  process.exitCode = result.status ?? 1;
}
