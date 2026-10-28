import assert from "node:assert/strict";
assert.match("заказ-42", /заказ-\d+/);
console.log("Совпало");
