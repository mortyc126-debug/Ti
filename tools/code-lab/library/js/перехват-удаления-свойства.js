const target = { имя: "Анна", роль: "админ" };
const proxy = new Proxy(target, {
  deleteProperty(target, key) {
    if (key === "роль") { console.log("роль удалять нельзя"); return false; }
    delete target[key];
    return true;
  }
});
console.log(Reflect.deleteProperty(proxy, "роль"));
console.log(Reflect.deleteProperty(proxy, "имя"));
console.log(target);
