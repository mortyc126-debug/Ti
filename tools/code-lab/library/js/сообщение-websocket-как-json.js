const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("message", event => {
  const data = JSON.parse(event.data);
  console.log(`Получено: ${data.type}`);
});
