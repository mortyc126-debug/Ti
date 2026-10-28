const object = { имя: "Анна" };
Object.defineProperty(object, "скрытое", { value: 1, enumerable: false });
console.log(Object.prototype.propertyIsEnumerable.call(object, "имя"));
console.log(Object.prototype.propertyIsEnumerable.call(object, "скрытое"));
console.log(Object.prototype.propertyIsEnumerable.call(object, "нет такого"));
