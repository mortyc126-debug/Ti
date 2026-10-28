const { mock } = require("node:test");

const object = { курс() { return 90; } };
mock.method(object, "курс", () => 100);
console.log(object.курс());
console.log(object.курс.mock.callCount());
mock.restoreAll();
console.log(object.курс());
