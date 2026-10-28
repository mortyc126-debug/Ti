const { promise, resolve, reject } = Promise.withResolvers();

setTimeout(() => resolve("готово"), 10);

console.log(await promise);
