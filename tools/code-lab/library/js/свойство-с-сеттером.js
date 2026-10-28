const object = { _возраст: 0 };
const key = "возраст";
Object.defineProperty(object, key, {
  set(value) { this._возраст = Math.max(0, value); },
  configurable: true
});
object.возраст = -5;
console.log(object._возраст);
object.возраст = 30;
console.log(object._возраст);
