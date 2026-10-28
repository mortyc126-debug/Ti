const controller = new AbortController();
fetch("/api/data", { signal: controller.signal })
  .then(r => r.json())
  .catch(error => { if (error.name === "AbortError") console.log("Отменено"); });
controller.abort();
