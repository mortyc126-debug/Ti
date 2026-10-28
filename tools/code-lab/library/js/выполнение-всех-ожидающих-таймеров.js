const { mock } = require("node:test");

mock.timers.enable({ apis: ["setTimeout"] });
setTimeout(() => console.log("первый"), 500);
setTimeout(() => console.log("второй"), 5000);
mock.timers.runAll();
mock.timers.reset();
