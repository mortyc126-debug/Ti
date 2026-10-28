const object = { имя: "Анна" };
Object.defineProperty(object, "скрытое", { value: 1, enumerable: false });
console.log(Object.getOwnPropertyNames(object));
console.log(Object.keys(object));
console.log(Object.getOwnPropertyNames([1, 2]));
