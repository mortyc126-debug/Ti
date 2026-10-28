function Person(name) {
  if (!new.target) throw new TypeError("Вызывайте через new");
  this.name = name;
}

console.log(new Person("Мира").name);

try {
  Person("Мира");
} catch (error) {
  console.log(error.message);
}
