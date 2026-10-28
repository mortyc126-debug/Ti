function greet(greeting) {
  return `${greeting}, ${this.name}!`;
}

greet.call = () => "подмена";

const user = { name: "Мира" };
console.log(greet.call(user, "Привет"));
console.log(Function.prototype.call.call(greet, user, "Привет"));
