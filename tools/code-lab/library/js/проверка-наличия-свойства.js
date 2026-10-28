const object = { имя: "Анна" };
console.log(Reflect.has(object, "имя"));
console.log(Reflect.has(object, "toString"));
console.log(Reflect.has(object, "нет такого"));
