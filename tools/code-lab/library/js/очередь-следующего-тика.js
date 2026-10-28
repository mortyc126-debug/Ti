setTimeout(() => console.log("таймер"), 0);
Promise.resolve().then(() => console.log("промис"));
process.nextTick(() => console.log("nextTick"));
console.log("синхронный код");
