const результаты = await Promise.all([Promise.resolve(2), Promise.resolve(4)]);
console.log(результаты);
