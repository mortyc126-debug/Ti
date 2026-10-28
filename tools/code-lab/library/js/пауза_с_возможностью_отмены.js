import { setTimeout as sleep } from "node:timers/promises";

const контроллер = new AbortController();
setTimeout(() => контроллер.abort(), 100);

try {
  await sleep(5000, undefined, { signal: контроллер.signal });
} catch (ошибка) {
  console.log(ошибка.name);
}
