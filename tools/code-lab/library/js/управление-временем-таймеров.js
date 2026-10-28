const { mock } = require("node:test");

mock.timers.enable({ apis: ["setTimeout"] });
setTimeout(() => console.log("сработал через секунду"), 1000);
console.log("до сдвига времени");
mock.timers.tick(1000);
mock.timers.reset();
