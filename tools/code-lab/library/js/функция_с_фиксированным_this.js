class Кнопка {
  constructor() {
    this.подпись = "ОК";
    this.нажать = this.нажать.bind(this);
  }

  нажать() {
    return this.подпись;
  }
}

const { нажать } = new Кнопка();
console.log(нажать());
