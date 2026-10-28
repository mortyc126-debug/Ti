const { spawnSync } = require("node:child_process");

const run = spawnSync("npx", ["vitest", "run", "--coverage"], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (run.status === 0) {
  console.log("Тесты и покрытие в порядке");
} else {
  console.log("Есть упавшие тесты или недобор покрытия");
}

process.exitCode = run.status ?? 1;
