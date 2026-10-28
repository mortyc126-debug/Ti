const object = {};
const descriptors = {
  имя: { value: "Анна", enumerable: true },
  возраст: { value: 25, writable: true, enumerable: true }
};
Object.defineProperties(object, descriptors);
console.log(object);
object.имя = "Мира";
console.log(object.имя);
