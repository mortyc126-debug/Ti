const { promise, resolve, reject } = Promise.withResolvers();
promise.then(значение => console.log("выполнен:", значение));
setTimeout(() => resolve("данные готовы"), 10);
console.log(typeof reject);
