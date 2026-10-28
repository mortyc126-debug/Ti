const test = require("node:test");
const assert = require("node:assert/strict");

async function loadConfig() {
  return { port: 3000 };
}

test("loadConfig возвращает порт", async () => {
  const config = await loadConfig();
  assert.equal(config.port, 3000);
});
