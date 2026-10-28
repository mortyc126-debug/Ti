const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("open", () => {
  const message = { type: "chat", text: "Привет всем" };
  socket.send(JSON.stringify(message));
});
