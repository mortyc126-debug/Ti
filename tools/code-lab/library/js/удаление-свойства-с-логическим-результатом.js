const object = { имя: "Анна", возраст: 25 };
console.log(Reflect.deleteProperty(object, "возраст"));
console.log(object);

const заморожен = Object.freeze({ имя: "Анна" });
console.log(Reflect.deleteProperty(заморожен, "имя"));
