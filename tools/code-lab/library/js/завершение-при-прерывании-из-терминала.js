const ожидание = setTimeout(() => {}, 1000); // держит процесс живым до прихода сигнала
function shutdown() {
  console.log("закрываем ресурсы и выходим");
  clearTimeout(ожидание);
}
process.on("SIGINT", shutdown);
process.kill(process.pid, "SIGINT");
