try {
  JSON.parse("{");
} catch (ошибка) {
  console.error("Не удалось разобрать JSON:", ошибка.message);
}
