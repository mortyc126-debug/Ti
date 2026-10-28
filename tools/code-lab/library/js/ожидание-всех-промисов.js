const пауза = (мс, значение) => new Promise(выполнить => setTimeout(() => выполнить(значение), мс));

Promise.all([пауза(30, "медленно"), пауза(10, "быстро"), "готовое значение"])
  .then(результаты => console.log(результаты));

Promise.all([Promise.resolve("успех"), Promise.reject(new Error("сбой"))])
  .catch(ошибка => console.log("отклонён:", ошибка.message));
