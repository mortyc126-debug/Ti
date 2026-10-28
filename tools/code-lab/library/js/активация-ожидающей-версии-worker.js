const updateButton = document.createElement("button");
updateButton.textContent = "Обновить приложение";
document.body.append(updateButton);

navigator.serviceWorker.getRegistration().then(registration => {
  updateButton.addEventListener("click", () => {
    registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
  });
});

navigator.serviceWorker.addEventListener("controllerchange", () => {
  window.location.reload();
});
