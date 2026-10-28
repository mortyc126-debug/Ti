const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);
socket.binaryType = "arraybuffer";

socket.addEventListener("message", event => {
  const bytes = new Uint8Array(event.data);
  console.log(`Получено байт: ${bytes.length}`);
});
