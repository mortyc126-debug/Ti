const результаты = await Promise.allSettled([
  Promise.resolve(1),
  Promise.reject(new Error("а")),
  Promise.reject(new Error("б")),
]);

try {
  const неудачные = результаты.filter(результат => результат.status === "rejected");
  if (неудачные.length) {
    throw new AggregateError(неудачные.map(результат => результат.reason), "часть задач не выполнена");
  }
} catch (ошибка) {
  console.log(ошибка.message, ошибка.errors.length);
}
