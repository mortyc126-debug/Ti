async function loadBoth() {
  const results = await Promise.all([
    Promise.resolve("цвета"),
    Promise.resolve("настройки")
  ]);
  console.log(results);
}

loadBoth();