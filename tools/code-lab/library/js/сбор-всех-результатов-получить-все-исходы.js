const исходы = await Promise.allSettled([Promise.resolve("ok"), Promise.reject(new Error("сбой"))]);
console.log(исходы.map(x => x.status));
