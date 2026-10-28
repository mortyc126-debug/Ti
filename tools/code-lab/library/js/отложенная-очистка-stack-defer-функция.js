function closeLog() {
  console.log("журнал закрыт");
}

function saveSettings() {
  const stack = new DisposableStack();
  stack.defer(closeLog);
  stack.defer(() => console.log("настройки записаны"));

  console.log("запись начата");
  stack.dispose();
}

saveSettings();
