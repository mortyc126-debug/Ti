const tasks = [
  Promise.reject(new Error("первая ошибка")),
  Promise.reject(new Error("вторая ошибка")),
];
Promise.any(tasks).catch(error => {
  console.log(error instanceof AggregateError);
  console.log(error.errors.map(причина => причина.message));
});
