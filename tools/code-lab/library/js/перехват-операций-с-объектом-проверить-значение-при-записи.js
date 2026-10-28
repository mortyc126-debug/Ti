const данные = new Proxy({ счёт: 0 }, {
  set(цель, ключ, значение) {
    if (ключ === "счёт" && !Number.isFinite(значение)) throw new TypeError("Нужно число");
    return Reflect.set(цель, ключ, значение);
  }
});
данные.счёт = 12;
console.log(данные.счёт);
