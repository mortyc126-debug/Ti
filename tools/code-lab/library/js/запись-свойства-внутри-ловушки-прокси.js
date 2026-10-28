const журнал = [];
const proxy = new Proxy({}, {
  set(target, key, value, receiver) {
    журнал.push(`запись ${String(key)}`);
    return Reflect.set(target, key, value, receiver);
  }
});
proxy.имя = "Анна";
console.log(proxy.имя);
console.log(журнал);
