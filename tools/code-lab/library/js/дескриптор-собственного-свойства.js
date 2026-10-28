const object = { имя: "Анна" };
const key = "имя";
console.log(Reflect.getOwnPropertyDescriptor(object, key));
console.log(Reflect.getOwnPropertyDescriptor(object, "нет такого"));
