const ошибка = new AggregateError(
  [new Error("а"), new Error("б")],
  "Несколько ошибок"
);

console.log(ошибка.name, ошибка.message, ошибка.errors.length);
