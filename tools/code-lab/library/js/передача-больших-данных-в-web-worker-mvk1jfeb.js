// main.js
const size = 1_000_000;
const largeArray = new Int32Array(size);
for (let i = 0; i < size; i++) largeArray[i] = i;

const worker = new Worker('worker.js');

// Передаём буфер без копирования
worker.postMessage(largeArray.buffer, [largeArray.buffer]);

worker.onmessage = (e) => {
  const processed = new Int32Array(e.data);
  console.log('Обработано:', processed.length, 'первые:', processed.slice(0, 5));
};

worker.onerror = (e) => console.error('Сбой воркера:', e.message);

// worker.js
self.onmessage = (e) => {
  const data = new Int32Array(e.data);
  for (let i = 0; i < data.length; i++) data[i] *= 10;   // правим на месте
  self.postMessage(data.buffer, [data.buffer]);          // возвращаем тоже без копирования
};