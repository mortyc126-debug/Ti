const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("open", () => {
  socket.send("до свидания");
  socket.close(1000, "done");
});

socket.addEventListener("close", event => {
  console.log(`Закрыто: ${event.code} ${event.reason}`);
});
