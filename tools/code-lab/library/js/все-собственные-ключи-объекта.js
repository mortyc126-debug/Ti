const id = Symbol("id");
const user = { name: "Мира", [id]: 7 };
Object.defineProperty(user, "secret", { value: 1, enumerable: false });

console.log(Object.keys(user));
console.log(Reflect.ownKeys(user));
