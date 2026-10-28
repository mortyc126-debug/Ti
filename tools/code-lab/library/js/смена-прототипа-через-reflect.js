const canFly = { fly: () => "летит" };
const bird = { name: "Чижик" };

console.log(Reflect.setPrototypeOf(bird, canFly));
console.log(bird.fly());

const sealedObject = Object.preventExtensions({});
console.log(Reflect.setPrototypeOf(sealedObject, canFly));
