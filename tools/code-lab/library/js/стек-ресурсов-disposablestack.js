function runJob() {
  using cleanup = new DisposableStack();

  cleanup.defer(() => console.log("временная папка удалена"));
  cleanup.defer(() => console.log("соединение закрыто"));

  console.log("работа выполняется");
}

runJob();
