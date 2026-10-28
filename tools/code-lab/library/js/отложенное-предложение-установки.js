let installPrompt = null;

const installButton = document.createElement("button");
installButton.textContent = "Установить приложение";
installButton.hidden = true;
document.body.append(installButton);

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
  installPrompt.prompt();
  const { outcome } = await installPrompt.userChoice;
  console.log(`Выбор пользователя: ${outcome}`);
  installPrompt = null;
  installButton.hidden = true;
});
