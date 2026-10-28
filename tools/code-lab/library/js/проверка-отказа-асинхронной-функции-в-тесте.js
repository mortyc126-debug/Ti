const test = require("node:test");
const assert = require("node:assert/strict");

async function failingRequest() {
  throw new Error("Сервер недоступен");
}

test("ошибка запроса пробрасывается наружу", async () => {
  await assert.rejects(failingRequest(), { message: "Сервер недоступен" });
});
