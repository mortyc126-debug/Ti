function сложить(первое, второе) { return первое + второе; }
const proxy = new Proxy(сложить, {
  apply(target, thisArg, args) {
    console.log("вызов с аргументами", args);
    return target(...args) * 10;
  }
});
console.log(proxy(2, 3));
