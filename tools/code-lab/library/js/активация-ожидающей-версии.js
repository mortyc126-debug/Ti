const registration = { // вместо настоящего ServiceWorkerRegistration
  waiting: { postMessage(сообщение) { console.log("отправлено:", сообщение); } }
};
registration.waiting?.postMessage({ type: "SKIP_WAITING" });

const безОжидающей = { waiting: null };
безОжидающей.waiting?.postMessage({ type: "SKIP_WAITING" });
console.log("если ожидающей версии нет, ошибки не будет");
