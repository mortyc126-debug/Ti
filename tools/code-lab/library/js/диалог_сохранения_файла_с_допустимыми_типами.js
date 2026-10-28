try {
  const дескриптор = await window.showSaveFilePicker({
    suggestedName: "отчёт.csv",
    types: [{ description: "CSV", accept: { "text/csv": [".csv"] } }],
  });
  console.log("Выбран файл:", дескриптор.name);
} catch (ошибка) {
  if (ошибка.name !== "AbortError") throw ошибка;
}
