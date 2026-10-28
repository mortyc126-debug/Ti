const rootCause = new Error("Нет соединения с базой");
const middle = new Error("Не удалось сохранить заказ", { cause: rootCause });
const error = new Error("Оформление заказа не выполнено", { cause: middle });

for (let current = error; current; current = current.cause) {
  console.error(current.message);
}
