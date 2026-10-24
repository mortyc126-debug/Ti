// main.js
const numbers = [9, 1, 5, 3, 7];
const worker = new Worker('worker.js');

worker.onmessage = (e) => {
  console.log('Результат сортировки:', e.data);
  worker.terminate();
};

worker.onerror = (e) => {
  console.error('Сбой воркера:', e.message);
  worker.terminate();
};

worker.postMessage(numbers);
// worker.js
self.onmessage = (e) => {
  const sorted = [...e.data].sort((a, b) => a - b);
  self.postMessage(sorted);
};