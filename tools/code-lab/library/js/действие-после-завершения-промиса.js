Promise.resolve("данные")
  .finally(() => console.log("очистка после успеха"))
  .then(значение => console.log(значение));

Promise.reject(new Error("сбой"))
  .finally(() => console.log("очистка после ошибки"))
  .catch(ошибка => console.log(ошибка.message));
