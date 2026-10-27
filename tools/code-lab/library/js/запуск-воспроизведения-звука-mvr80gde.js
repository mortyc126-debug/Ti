const сигнал = new Audio("/звуки/сигнал.mp3");

try {
  await сигнал.play();
  console.log("Играет");
} catch (ошибка) {
  console.log("Автозапуск запрещён:", ошибка.name);
}