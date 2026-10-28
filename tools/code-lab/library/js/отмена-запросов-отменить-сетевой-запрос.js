const controller = new AbortController();
const запрос = fetch("/api/data", { signal: controller.signal });
controller.abort();
try { await запрос; } catch (ошибка) { console.log(ошибка.name); }
