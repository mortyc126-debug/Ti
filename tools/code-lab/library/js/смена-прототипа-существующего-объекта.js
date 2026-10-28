const животное = { голос() { return "звук"; } };
const prototype = { голос() { return "мяу"; } };
const object = Object.create(животное);
console.log(object.голос());
Object.setPrototypeOf(object, prototype);
console.log(object.голос());
