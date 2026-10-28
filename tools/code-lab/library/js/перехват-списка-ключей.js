const target = { имя: "Анна", _пароль: "секрет", город: "Омск" };
const proxy = new Proxy(target, {
  ownKeys(target) {
    return Reflect.ownKeys(target).filter(key => !String(key).startsWith("_"));
  }
});
console.log(Object.keys(proxy));
console.log(proxy._пароль);
