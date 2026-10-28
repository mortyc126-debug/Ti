const канал = new MessageChannel();

канал.port2.onmessage = событие => {
  console.log("Получено:", событие.data);
  канал.port2.close();
};

канал.port1.postMessage("привет");
