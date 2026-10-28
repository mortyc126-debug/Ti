const object = {};
const key = "код";
const descriptor = { value: 7, writable: false, enumerable: true };
console.log(Reflect.defineProperty(object, key, descriptor));
console.log(object.код);
console.log(Reflect.defineProperty(Object.freeze({}), "новое", { value: 1 }));
