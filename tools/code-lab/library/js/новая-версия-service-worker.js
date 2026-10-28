navigator.serviceWorker.register("/sw.js").then(registration => {
  registration.addEventListener("updatefound", () => {
    const newWorker = registration.installing;

    newWorker.addEventListener("statechange", () => {
      if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
        console.log("Доступна новая версия приложения");
      }
    });
  });
});
