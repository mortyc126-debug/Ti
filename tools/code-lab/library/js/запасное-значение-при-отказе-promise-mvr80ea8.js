const настройки = await fetch("/api/настройки")
  .then(ответ => ответ.json())
  .catch(ошибка => ({ тема: "светлая" }));

console.log(настройки.тема);