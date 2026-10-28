const object = { имя: "Анна" };
console.log(Object.isExtensible(object));
Object.preventExtensions(object);
console.log(Object.isExtensible(object));
console.log(Object.isExtensible(Object.freeze({})));
