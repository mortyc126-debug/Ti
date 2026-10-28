const сокет = new WebSocket("wss://echo.websocket.org");

await new Promise((разрешить, отклонить) => {
  сокет.addEventListener("open", разрешить, { once: true });
  сокет.addEventListener("error", отклонить, { once: true });
});

сокет.send("привет");
