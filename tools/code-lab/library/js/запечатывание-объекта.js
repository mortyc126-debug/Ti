const object = { имя: "Анна" };
Object.seal(object);
object.имя = "Мира";
object.возраст = 25;
delete object.имя;
console.log(object);
