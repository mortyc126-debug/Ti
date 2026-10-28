const контроллер = new AbortController();

const обработчик = () => console.log("Отменено:", контроллер.signal.reason.name);
контроллер.signal.addEventListener("abort", обработчик);

контроллер.abort();
