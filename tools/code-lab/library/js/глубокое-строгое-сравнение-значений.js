const util = require("node:util");

const savedSettings = { theme: "dark", tabs: [1, 2, 3] };
const currentSettings = { theme: "dark", tabs: [1, 2, 3] };

console.log(savedSettings === currentSettings);
console.log(util.isDeepStrictEqual(savedSettings, currentSettings));
console.log(util.isDeepStrictEqual({ count: 1 }, { count: "1" }));
