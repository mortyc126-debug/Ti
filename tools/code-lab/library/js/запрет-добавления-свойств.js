const object = { имя: "Анна" };
console.log(Reflect.preventExtensions(object));
console.log(Reflect.isExtensible(object));
console.log(Reflect.set(object, "возраст", 25));
object.имя = "Мира";
console.log(object);
