function вГруппе(название, действие) {
  console.group(название);
  try {
    действие();
  } finally {
    console.groupEnd();
  }
}

вГруппе("Импорт", () => {
  console.log("читаю файл");
  вГруппе("Проверка", () => console.log("ошибок нет"));
});
