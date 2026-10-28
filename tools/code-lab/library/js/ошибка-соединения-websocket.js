const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("error", () => {
  console.log("Ошибка соединения с сервером");
});
