const os = require("node:os");
console.log(typeof os.platform());
console.log(os.platform() === process.platform);
