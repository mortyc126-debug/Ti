const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("close", event => {
  console.log(event.code, event.reason);
  if (event.code !== 1000) {
    console.log("Соединение оборвано, пробуем переподключиться");
  }
});
