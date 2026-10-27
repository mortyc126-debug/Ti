const стек = new AsyncDisposableStack();

стек.defer(async () => console.log("закрыта база"));
стек.defer(async () => console.log("закрыт файл"));

await стек.disposeAsync();