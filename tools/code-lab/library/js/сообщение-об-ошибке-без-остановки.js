addEventListener("error", событие => {
  console.log("глобальный обработчик получил:", событие.message);
});
reportError(new Error("сбой в фоновой задаче"));
console.log("выполнение продолжается");
