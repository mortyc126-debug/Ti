const object = { имя: "Анна" };
Object.preventExtensions(object);
object.возраст = 25;
object.имя = "Мира";
delete object.имя;
console.log(object);
