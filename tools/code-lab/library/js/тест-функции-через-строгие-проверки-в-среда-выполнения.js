import assert from "node:assert/strict";
const add = (a, b) => a + b;
assert.equal(add(2, 3), 5);
assert.deepEqual([1, 2], [1, 2]);
console.log("Тесты пройдены");
