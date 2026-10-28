const { EventEmitter } = require("node:events");

const emitter = new EventEmitter();

function onMessage(text) {
  console.log(`Получено: ${text}`);
}

emitter.on("message", onMessage);
emitter.emit("message", "первое");

emitter.off("message", onMessage);
emitter.emit("message", "второе");

console.log(`Подписчиков: ${emitter.listenerCount("message")}`);
