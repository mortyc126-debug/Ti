let isLoading = false;

async function loadData(shouldFail) {
  isLoading = true;
  try {
    if (shouldFail) throw new Error("Сервер недоступен");
    console.log("Данные загружены");
  } catch (error) {
    console.log(`Ошибка: ${error.message}`);
  } finally {
    isLoading = false;
    console.log(`Загрузка завершена, isLoading = ${isLoading}`);
  }
}

loadData(false).then(() => loadData(true));
