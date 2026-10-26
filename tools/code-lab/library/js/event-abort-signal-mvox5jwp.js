const controller = new AbortController();
окно.addEventListener("resize", обновитьРазмер, { signal: controller.signal });
документ.addEventListener("visibilitychange", обновитьВидимость, { signal: controller.signal });
// при очистке компонента:
controller.abort();
