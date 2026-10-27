import assert from "node:assert/strict";
await assert.rejects(async () => { throw new Error("Сбой"); });
console.log("Отклонение проверено");