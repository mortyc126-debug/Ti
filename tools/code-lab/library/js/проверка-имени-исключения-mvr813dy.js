import assert from "node:assert/strict";
assert.throws(() => { throw new TypeError("Неверно"); }, { name: "TypeError" });