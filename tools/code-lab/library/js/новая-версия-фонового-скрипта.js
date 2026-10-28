const registration = new EventTarget(); // вместо настоящего ServiceWorkerRegistration
registration.addEventListener("updatefound", () => {
  console.log("найдена новая версия приложения");
});
registration.dispatchEvent(new Event("updatefound"));
