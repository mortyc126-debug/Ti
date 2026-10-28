class Животное {}
class Кошка extends Животное {}

const object = new Кошка();
console.log(Reflect.getPrototypeOf(object) === Кошка.prototype);
console.log(Reflect.getPrototypeOf(Кошка.prototype) === Животное.prototype);
