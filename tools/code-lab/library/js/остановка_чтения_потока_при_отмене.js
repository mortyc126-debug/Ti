const контроллер = new AbortController();
const ответ = await fetch("/api/большой-файл", { signal: контроллер.signal });
const читатель = ответ.body.getReader();

контроллер.signal.addEventListener("abort", () => читатель.cancel(), { once: true });

while (true) {
  const { done } = await читатель.read();
  if (done) break;
}
