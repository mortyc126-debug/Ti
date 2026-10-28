class Animal {}
class Dog extends Animal {}

const pet = new Dog();

console.log(Reflect.getPrototypeOf(pet) === Dog.prototype);
console.log(Reflect.getPrototypeOf(Dog.prototype) === Animal.prototype);
console.log(Reflect.getPrototypeOf(Object.create(null)));
