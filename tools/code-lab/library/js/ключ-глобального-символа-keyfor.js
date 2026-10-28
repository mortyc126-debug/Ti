const shared = Symbol.for("app.userId");
const local = Symbol("app.userId");

console.log(Symbol.keyFor(shared));
console.log(Symbol.keyFor(local));
console.log(Symbol.for("app.userId") === shared);
