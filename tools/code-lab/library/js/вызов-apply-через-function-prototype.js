function introduce(greeting, punctuation) {
  return `${greeting}, я ${this.name}${punctuation}`;
}

introduce.apply = null;

const user = { name: "Мира" };
console.log(Function.prototype.apply.call(introduce, user, ["Привет", "!"]));
