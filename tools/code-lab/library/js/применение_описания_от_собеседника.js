const соединение = new RTCPeerConnection();

сигналы.addEventListener("message", async событие => {
  const сообщение = JSON.parse(событие.data);
  if (сообщение.type === "offer") {
    await соединение.setRemoteDescription(сообщение);
    const ответ = await соединение.createAnswer();
    await соединение.setLocalDescription(ответ);
    сигналы.send(JSON.stringify(соединение.localDescription));
  }
});
