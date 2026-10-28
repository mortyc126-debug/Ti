function шаг(сигнал) {
  сигнал.throwIfAborted();
  return "выполнено";
}

const контроллер = new AbortController();
контроллер.abort();

try {
  шаг(контроллер.signal);
} catch (ошибка) {
  console.log(ошибка.name);
}
