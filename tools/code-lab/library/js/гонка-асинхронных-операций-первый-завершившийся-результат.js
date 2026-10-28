const быстро = new Promise(resolve => setTimeout(() => resolve("A"), 20));
const медленно = new Promise(resolve => setTimeout(() => resolve("B"), 100));
Promise.race([быстро, медленно]).then(console.log);
