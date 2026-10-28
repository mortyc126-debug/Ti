const object = { имя: "Анна", фамилия: "Иванова" };
const key = "полноеИмя";
Object.defineProperty(object, key, {
  get() { return `${this.имя} ${this.фамилия}`; },
  enumerable: true,
  configurable: true
});
console.log(object.полноеИмя);
object.имя = "Мира";
console.log(object.полноеИмя);
