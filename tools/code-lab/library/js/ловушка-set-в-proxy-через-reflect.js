const person = { age: 20 };

const checked = new Proxy(person, {
  set(target, key, value, receiver) {
    if (key === "age" && !Number.isInteger(value)) {
      throw new TypeError("age должен быть целым числом");
    }
    return Reflect.set(target, key, value, receiver);
  },
});

checked.age = 21;
console.log(person.age);

try {
  checked.age = "двадцать";
} catch (error) {
  console.log(error.message);
}
