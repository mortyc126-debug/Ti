import util from "node:util";

class Пользователь {
  constructor(имя) {
    this.имя = имя;
  }
  [util.inspect.custom]() {
    return `Пользователь<${this.имя}>`;
  }
}

console.log(new Пользователь("Мира"));
