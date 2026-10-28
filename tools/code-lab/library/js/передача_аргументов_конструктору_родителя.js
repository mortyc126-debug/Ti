class Основа {
  constructor(имя, возраст) {
    this.имя = имя;
    this.возраст = возраст;
  }
}

class Потомок extends Основа {
  constructor(...аргументы) {
    super(...аргументы);
    this.создан = true;
  }
}

const человек = new Потомок("Мира", 30);
console.log(человек);
