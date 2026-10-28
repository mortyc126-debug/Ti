async function processInChunks(items, size, handle) {
  for (let i = 0; i < items.length; i += size) {
    handle(items.slice(i, i + size));
    await new Promise(resolve => setTimeout(resolve));
  }
}

const numbers = Array.from({ length: 10 }, (_, index) => index + 1);

processInChunks(numbers, 4, chunk => {
  console.log(`порция ${chunk.join(", ")}: сумма ${chunk.reduce((sum, n) => sum + n, 0)}`);
});
