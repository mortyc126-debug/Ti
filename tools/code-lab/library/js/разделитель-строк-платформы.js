const os = require("node:os");
console.log(JSON.stringify(os.EOL));
console.log(["первая", "вторая"].join(os.EOL).split(os.EOL).length);
