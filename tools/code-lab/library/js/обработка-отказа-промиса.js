const promise = Promise.reject(new Error("не удалось загрузить"));
promise
  .catch(error => {
    console.log("ошибка:", error.message);
    return "запасное значение";
  })
  .then(значение => console.log(значение));
