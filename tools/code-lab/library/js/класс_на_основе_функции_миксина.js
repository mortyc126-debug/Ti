const СПодписью = База => class extends База {
  подпись() {
    return `${this.constructor.name}: ${this.имя}`;
  }
};

class Человек {
  constructor(имя) {
    this.имя = имя;
  }
}

class Автор extends СПодписью(Человек) {}

console.log(new Автор("Лев").подпись());
