const { EventEmitter } = require("node:events");
const page = new EventEmitter(); // вместо настоящей страницы Playwright
page.on("console", message => console.log(message.text()));
page.emit("console", { text: () => "сообщение из консоли страницы" });
