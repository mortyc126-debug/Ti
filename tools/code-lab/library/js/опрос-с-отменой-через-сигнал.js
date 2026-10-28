function sleep(milliseconds, signal) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timerId = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timerId);
        resolve();
      },
      { once: true }
    );
  });
}

let attempts = 0;
async function poll() {
  attempts += 1;
  console.log(`Проверка статуса, попытка ${attempts}`);
}

async function watchStatus(signal, interval) {
  while (!signal.aborted) {
    await poll();
    await sleep(interval, signal);
  }
  console.log("Опрос остановлен");
}

const controller = new AbortController();
setTimeout(() => controller.abort(), 550);
watchStatus(controller.signal, 200);
