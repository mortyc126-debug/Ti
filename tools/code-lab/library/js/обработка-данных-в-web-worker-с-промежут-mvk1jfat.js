// main.js
const data = [1, 2, 3, 4, 5, 6];
const worker = new Worker('worker.js');

worker.onmessage = (e) => {
  console.log('Фильтрованные данные:', e.data.filtered);
  console.log('Преобразованные данные:', e.data.transformed);
  worker.terminate();   // воркер больше не нужен, освобождаем поток
};

worker.onerror = (e) => {
  console.error('Сбой воркера:', e.message);
  worker.terminate();
};

worker.postMessage(data);
// worker.js
self.onmessage = (e) => {
  const filtered = e.data.filter(x => x % 2 === 0);
  const transformed = filtered.map(x => x * 2);
  self.postMessage({ filtered, transformed });
};