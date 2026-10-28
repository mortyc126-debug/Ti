const object = {};
const key = "код";
const value = 42;
Object.defineProperty(object, key, { value, writable: false, enumerable: false, configurable: false });
object.код = 100;
console.log(object.код);
console.log(Object.keys(object));
console.log(delete object.код);
