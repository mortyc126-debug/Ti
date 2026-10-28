async function сОграничением(элементы, лимит, задача) {
  const результаты = new Array(элементы.length);
  let следующий = 0;
  async function рабочий() {
    while (true) {
      const i = следующий++;
      if (i >= элементы.length) return;
      результаты[i] = await задача(элементы[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(лимит, элементы.length) }, рабоч));
  return результаты;
}
