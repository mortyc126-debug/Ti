const proto = { тип: "основа" };
const object = Object.create(proto);
console.log(Object.prototype.isPrototypeOf.call(proto, object));
console.log(Object.prototype.isPrototypeOf.call(object, proto));
console.log(Object.prototype.isPrototypeOf.call(Object.prototype, object));
