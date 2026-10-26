function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Отменено', 'AbortError'));
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Отменено', 'AbortError'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
// await abortableDelay(1000, controller.signal);
