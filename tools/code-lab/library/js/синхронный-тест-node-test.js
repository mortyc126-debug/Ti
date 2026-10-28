const test = require("node:test");
const assert = require("node:assert/strict");

function sum(first, second) {
  return first + second;
}

test("sum складывает числа", () => {
  assert.equal(sum(2, 3), 5);
});
