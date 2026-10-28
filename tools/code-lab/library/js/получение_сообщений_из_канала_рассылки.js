const канал = new BroadcastChannel("updates");

канал.onmessage = событие => {
  console.log("Получено:", событие.data.тип);
};

window.addEventListener("pagehide", () => канал.close());
