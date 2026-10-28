const buffer = new ArrayBuffer(1024);
worker.postMessage(buffer, [buffer]);
console.log(buffer.byteLength); // 0 после передачи владения
