const object = { имя: "Анна" };
console.log(Object.isSealed(object));
Object.seal(object);
console.log(Object.isSealed(object));
console.log(Object.isSealed(Object.freeze({ а: 1 })));
