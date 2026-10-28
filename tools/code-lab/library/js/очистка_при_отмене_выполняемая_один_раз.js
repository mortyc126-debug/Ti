const контроллер = new AbortController();

function очистка() {
  console.log("Очистка выполнена");
}

контроллер.signal.addEventListener("abort", очистка, { once: true });

контроллер.abort();
контроллер.abort();
