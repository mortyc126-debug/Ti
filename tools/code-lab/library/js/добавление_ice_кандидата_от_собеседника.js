const соединение = new RTCPeerConnection();

сигналы.addEventListener("message", async событие => {
  const сообщение = JSON.parse(событие.data);
  if (сообщение.candidate) {
    await соединение.addIceCandidate(сообщение.candidate);
  }
});
