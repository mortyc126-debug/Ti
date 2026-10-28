const ожидание = setTimeout(() => {}, 1000); // держит процесс живым до прихода сигнала
function shutdown() {
  console.log("получен сигнал остановки, завершаем работу");
  clearTimeout(ожидание);
}
process.once("SIGTERM", shutdown);
process.kill(process.pid, "SIGTERM");
