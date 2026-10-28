function ждать(мс, имя, сигнал) {
  return new Promise((разрешить, отклонить) => {
    const таймер = setTimeout(() => разрешить(имя), мс);
    сигнал.addEventListener("abort", () => {
      clearTimeout(таймер);
      отклонить(сигнал.reason);
    }, { once: true });
  });
}

const контроллер = new AbortController();
try {
  const первый = await Promise.race([
    ждать(10, "быстрый", контроллер.signal),
    ждать(500, "медленный", контроллер.signal).catch(() => {}),
  ]);
  console.log(первый);
} finally {
  контроллер.abort();
}
