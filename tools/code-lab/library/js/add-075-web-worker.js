// main.js
const worker = new Worker("worker.js", { type: "module" });
worker.postMessage([1, 2, 3]);
worker.onmessage = event => { console.log(event.data); worker.terminate(); };

// worker.js
self.onmessage = event => self.postMessage(event.data.map(x => x * 2));
