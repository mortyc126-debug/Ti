const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("open", () => {
  console.log("Соединение установлено");
  socket.send("привет");
});
