const base = { greet() {} };
const profile = Object.create(base);
profile.name = "Мира";

console.log(Reflect.has(profile, "name"));
console.log(Reflect.has(profile, "greet"));
console.log(Reflect.has(profile, "age"));
console.log(Object.hasOwn(profile, "greet"));
