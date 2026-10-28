globalThis.addEventListener("unhandledrejection", event => {
  event.preventDefault();
  console.log(`Необработанный отказ: ${event.reason}`);
});

Promise.reject("Сервер недоступен");
