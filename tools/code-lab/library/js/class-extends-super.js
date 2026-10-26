class Устройство {
  constructor(имя) { this.имя = имя; }
  описание() { return this.имя; }
}
class Датчик extends Устройство {
  constructor(имя, единица) { super(имя); this.единица = единица; }
  описание() { return `${super.описание()} (${this.единица})`; }
}
console.log(new Датчик("Температура", "°C").описание());
