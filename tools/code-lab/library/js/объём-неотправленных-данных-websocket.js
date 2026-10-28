const serverUrl = "ws://localhost:8080";
const socket = new WebSocket(serverUrl);

socket.addEventListener("open", () => {
  const timerId = setInterval(() => {
    if (socket.bufferedAmount > 1024 * 1024) {
      console.log("Буфер заполнен, ждём");
      return;
    }
    socket.send("x".repeat(100000));
    console.log(`В буфере: ${socket.bufferedAmount} байт`);
  }, 100);

  socket.addEventListener("close", () => clearInterval(timerId));
});
