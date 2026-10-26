function withTimeout(promise, ms, label = 'Операция') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: превышен тайм-аут ${ms} мс`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}
// const result = await withTimeout(loadData(), 3000, 'Загрузка данных');
