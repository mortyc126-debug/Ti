import assert from "node:assert/strict";
await assert.rejects(Promise.reject(new Error("Failed")), { message: "Failed" });