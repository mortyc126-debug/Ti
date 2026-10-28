import assert from "node:assert/strict";

function задача(сигнал) {
  return new Promise((_, отклонить) => {
    сигнал.addEventListener("abort", () => отклонить(сигнал.reason), { once: true });
  });
}

const контроллер = new AbortController();
const обещание = задача(контроллер.signal);
контроллер.abort();

await assert.rejects(обещание);
console.log("Отмена поддерживается");
