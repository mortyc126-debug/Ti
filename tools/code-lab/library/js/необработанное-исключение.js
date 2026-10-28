function handler(ошибка) {
  console.log("необработанная ошибка:", ошибка.message);
  process.exitCode = 1;
}
process.on("uncaughtException", handler);
setTimeout(() => { throw new Error("неожиданный сбой"); }, 0);
