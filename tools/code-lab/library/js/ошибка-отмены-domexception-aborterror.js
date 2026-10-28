function waitFor(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Операция отменена", "AbortError"));
      return;
    }
    const timerId = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timerId);
      reject(new DOMException("Операция отменена", "AbortError"));
    });
  });
}

const controller = new AbortController();
setTimeout(() => controller.abort(), 50);

waitFor(1000, controller.signal).catch(error => {
  console.log(error.name, "-", error.message);
});
