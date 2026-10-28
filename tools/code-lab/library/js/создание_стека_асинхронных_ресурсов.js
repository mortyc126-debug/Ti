async function обработать() {
  await using стек = new AsyncDisposableStack();
  стек.defer(async () => console.log("1: закрыто соединение"));
  стек.defer(async () => console.log("2: удалён временный файл"));
  console.log("идёт работа");
}

await обработать();
