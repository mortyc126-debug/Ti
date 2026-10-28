import { EventEmitter, once } from "node:events";

const источник = new EventEmitter();
setTimeout(() => источник.emit("ready", 42), 10);

const [результат] = await once(источник, "ready");
console.log(результат);
