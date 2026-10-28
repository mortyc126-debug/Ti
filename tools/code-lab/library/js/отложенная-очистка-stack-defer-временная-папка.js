function createTempDir() {
  console.log("временная папка создана");
  return "/tmp/report-work";
}

function removeTempDir(path) {
  console.log(`папка ${path} удалена`);
}

function buildReport() {
  using stack = new DisposableStack();
  const tempDir = createTempDir();
  stack.defer(() => removeTempDir(tempDir));

  console.log("отчёт собирается");
}

buildReport();
