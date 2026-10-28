const target = {};
const proxy = new Proxy(target, {
  set(target, key, value) {
    if (key === "возраст" && typeof value !== "number") {
      console.log("возраст должен быть числом");
      return true;
    }
    target[key] = value;
    return true;
  }
});
proxy.возраст = "двадцать";
proxy.возраст = 25;
console.log(target);
