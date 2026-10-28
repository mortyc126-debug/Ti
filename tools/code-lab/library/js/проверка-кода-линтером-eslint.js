const { spawnSync } = require("node:child_process");

const result = spawnSync("npx", ["eslint", "."], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

console.log(result.status === 0 ? "Линтер доволен" : "Найдены замечания линтера");
process.exitCode = result.status ?? 1;
