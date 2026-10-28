const start = performance.now();
const result = Array.from({ length: 10000 }, (_, i) => i * i);
const elapsedMs = performance.now() - start;
console.log(result.length, elapsedMs);
