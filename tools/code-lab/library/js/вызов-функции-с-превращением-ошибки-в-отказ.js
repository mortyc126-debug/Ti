if (typeof Promise.try !== "function") {
  Promise.try = (функция, ...аргументы) => new Promise(выполнить => выполнить(функция(...аргументы)));
}
const callback = () => { throw new Error("синхронный сбой"); };
Promise.try(callback)
  .catch(ошибка => console.log("отказ промиса:", ошибка.message));
Promise.try(() => "обычный результат")
  .then(значение => console.log(значение));
