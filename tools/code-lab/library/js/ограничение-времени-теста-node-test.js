const test = require("node:test");
const assert = require("node:assert/strict");

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("быстрая операция укладывается в секунду", { timeout: 1000 }, async () => {
  await pause(50);
  assert.ok(true);
});
