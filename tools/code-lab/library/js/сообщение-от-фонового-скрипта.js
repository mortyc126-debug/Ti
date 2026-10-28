navigator.serviceWorker.addEventListener("message", event => {
  console.log("сообщение от воркера:", event.data.type);
});
