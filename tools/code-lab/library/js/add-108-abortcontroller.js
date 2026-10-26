const controller = new AbortController();
window.addEventListener("resize", onResize, { signal: controller.signal });
document.addEventListener("keydown", onKey, { signal: controller.signal });
// при закрытии компонента: controller.abort();
