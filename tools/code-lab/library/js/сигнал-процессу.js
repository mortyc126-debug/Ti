const { spawn } = require("node:child_process");
const дочерний = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
дочерний.on("exit", (код, сигнал) => console.log("остановлен сигналом", сигнал));
дочерний.on("spawn", () => process.kill(дочерний.pid, "SIGTERM"));
