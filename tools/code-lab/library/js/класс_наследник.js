class Животное {
  constructor(имя) {
    this.имя = имя;
  }
  говорить() {
    return `${this.имя} издаёт звук`;
  }
}

class Собака extends Животное {}

const рекс = new Собака("Рекс");
console.log(рекс.говорить());
console.log(рекс instanceof Животное);
