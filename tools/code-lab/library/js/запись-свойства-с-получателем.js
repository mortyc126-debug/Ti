const object = {
  _имя: "",
  set имя(значение) { this._имя = значение; }
};
const key = "имя";
const value = "Анна";
const receiver = {};
console.log(Reflect.set(object, key, value, receiver));
console.log(receiver._имя);
console.log(object._имя === "");
