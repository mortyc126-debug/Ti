const регистрация = await navigator.serviceWorker.getRegistration();

if (регистрация) {
  const удалена = await регистрация.unregister();
  console.log("Удалён:", удалена);
}