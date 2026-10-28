const { EventEmitter } = require("node:events");

const emitter = new EventEmitter();

emitter.once("ready", () => console.log("Система готова"));

emitter.emit("ready");
emitter.emit("ready");

console.log(`Подписчиков: ${emitter.listenerCount("ready")}`);
