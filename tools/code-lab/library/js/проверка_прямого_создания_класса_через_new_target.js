class Фигура {
  constructor() {
    if (new.target === Фигура) {
      throw new TypeError("Фигура — абстрактный класс");
    }
  }
}

class Круг extends Фигура {}

console.log(new Круг() instanceof Фигура);
try {
  new Фигура();
} catch (ошибка) {
  console.log(ошибка.message);
}
