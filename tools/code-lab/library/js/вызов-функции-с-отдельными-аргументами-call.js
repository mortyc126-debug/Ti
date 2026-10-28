function introduce(greeting, punctuation) {
  return `${greeting}, я ${this.name}${punctuation}`;
}

const first = { name: "Мира" };
const second = { name: "Олег" };

console.log(introduce.call(first, "Привет", "!"));
console.log(introduce.call(second, "Здравствуйте", "."));
