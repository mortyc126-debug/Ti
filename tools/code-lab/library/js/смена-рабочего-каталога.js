const os = require("node:os");
const было = process.cwd();
process.chdir(os.tmpdir());
console.log(process.cwd() !== было);
process.chdir(было);
console.log(process.cwd() === было);
