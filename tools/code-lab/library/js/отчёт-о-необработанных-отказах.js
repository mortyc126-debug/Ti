function report(reason) {
  const text = reason instanceof Error ? reason.message : String(reason);
  console.error(`Отчёт об ошибке: ${text}`);
}

window.addEventListener("unhandledrejection", event => {
  event.preventDefault();
  report(event.reason);
});

Promise.reject(new Error("Сервер недоступен"));
