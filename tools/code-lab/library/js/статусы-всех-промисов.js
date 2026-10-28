Promise.allSettled([
  Promise.resolve("успех"),
  Promise.reject(new Error("сбой")),
]).then(результаты => {
  console.log(результаты.map(результат => результат.status));
  console.log(результаты[1].reason.message);
});
