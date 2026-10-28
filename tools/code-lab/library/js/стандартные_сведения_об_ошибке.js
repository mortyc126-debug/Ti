try {
  throw new Error("Не удалось сохранить", { cause: new Error("диск полон") });
} catch (ошибка) {
  const { name, message, cause } = ошибка;
  console.log(name, message, cause.message);
}
