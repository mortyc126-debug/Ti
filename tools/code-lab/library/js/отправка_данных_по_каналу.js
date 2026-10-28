const соединение = new RTCPeerConnection();
const канал = соединение.createDataChannel("чат");

канал.addEventListener("open", () => {
  канал.send("Привет!");
});
