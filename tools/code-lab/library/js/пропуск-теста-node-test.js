const test = require("node:test");
const assert = require("node:assert/strict");

test("загрузка с реального сервера", { skip: true }, () => {
  assert.fail("не должен выполняться");
});

test("обычный тест выполняется", () => {
  assert.equal(1 + 1, 2);
});
