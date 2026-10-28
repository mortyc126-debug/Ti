const животное = { голос() { return "звук"; } };
const object = {};
const prototype = животное;
console.log(Reflect.setPrototypeOf(object, prototype));
console.log(object.голос());
console.log(Reflect.setPrototypeOf(Object.preventExtensions({}), prototype));
