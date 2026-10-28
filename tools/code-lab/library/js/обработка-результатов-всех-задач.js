const tasks = [
  Promise.resolve("первая"),
  Promise.reject(new Error("вторая упала")),
  Promise.resolve("третья"),
];
Promise.allSettled(tasks).then(results => {
  const успешные = results.filter(результат => результат.status === "fulfilled");
  const неудачные = results.filter(результат => результат.status === "rejected");
  console.log(успешные.map(результат => результат.value));
  console.log(неудачные.length);
});
