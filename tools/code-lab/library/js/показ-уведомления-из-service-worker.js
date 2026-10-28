self.addEventListener("message", event => {
  if (event.data?.type !== "REMINDER") return;

  event.waitUntil(
    self.registration.showNotification("Напоминание", { body: event.data.text })
  );
});
