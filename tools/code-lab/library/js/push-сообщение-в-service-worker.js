self.addEventListener("push", event => {
  const message = event.data?.json() ?? { title: "Новое сообщение", body: "" };

  event.waitUntil(
    self.registration.showNotification(message.title, { body: message.body })
  );
});
