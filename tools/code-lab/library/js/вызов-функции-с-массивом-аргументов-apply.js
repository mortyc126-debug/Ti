function introduce(greeting, punctuation) {
  return `${greeting}, я ${this.name}${punctuation}`;
}

const user = { name: "Мира" };

console.log(introduce.apply(user, ["Привет", "!"]));
console.log(Math.max.apply(null, [3, 9, 4]));
