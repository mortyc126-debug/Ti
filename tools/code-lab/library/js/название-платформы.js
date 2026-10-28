const os = require("node:os");
console.log(typeof process.platform);
console.log(process.platform === os.platform());
console.log(["linux", "darwin", "win32"].includes(process.platform));
