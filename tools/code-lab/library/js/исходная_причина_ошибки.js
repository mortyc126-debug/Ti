try {
  try {
    JSON.parse("{");
  } catch (низкоуровневая) {
    throw new Error("Конфигурация повреждена", { cause: низкоуровневая });
  }
} catch (ошибка) {
  const причина = ошибка.cause;
  console.log(причина.name);
}
