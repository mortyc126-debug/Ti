// main.js
const worker = new Worker('worker.js');

worker.onmessage = (e) => {
  if (e.data && e.data.error) {
    console.error('Ошибка:', e.data.error);
  } else {
    console.log('Результат:', e.data);
  }
};

worker.onerror = (e) => console.error('Сбой воркера:', e.message);

worker.postMessage([10, 2]);   // нормальный случай
worker.postMessage([10, 0]);   // случай с ошибкой

// worker.js
self.onmessage = (e) => {
  try {
    const [a, b] = e.data;
    if (b === 0) throw new Error('Деление на ноль');
    self.postMessage(a / b);
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};