const причины = ["таймаут", "отказ сервера"].map(текст => new Error(текст));
const ошибка = new AggregateError(причины, "all failed");

console.log(ошибка.message, ошибка.errors.map(причина => причина.message));

try {
  await Promise.any([Promise.reject(причины[0]), Promise.reject(причины[1])]);
} catch (найденная) {
  console.log(найденная instanceof AggregateError);
}
