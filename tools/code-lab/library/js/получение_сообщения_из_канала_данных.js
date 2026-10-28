const соединение = new RTCPeerConnection();
const канал = соединение.createDataChannel("чат");

канал.addEventListener("message", событие => {
  console.log("Получено:", событие.data);
});
