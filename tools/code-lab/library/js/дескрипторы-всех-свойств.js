const object = { имя: "Анна", get приветствие() { return "Привет, " + this.имя; } };
const дескрипторы = Object.getOwnPropertyDescriptors(object);
console.log(Object.keys(дескрипторы));
console.log(typeof дескрипторы.приветствие.get);
console.log(дескрипторы.имя.value);
