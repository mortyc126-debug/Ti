const target = { имя: "Анна" };
const proxy = new Proxy(target, {
  get(target, key) {
    return key in target ? target[key] : `нет свойства «${String(key)}»`;
  }
});
console.log(proxy.имя);
console.log(proxy.возраст);
