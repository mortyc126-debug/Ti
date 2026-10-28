class Конфиг {
  static значения = new Map();
  static добавить(ключ, значение) {
    this.значения.set(ключ, значение);
  }
}

class КонфигСервера extends Конфиг {
  static {
    this.добавить("порт", 8080);
  }
}

console.log(Конфиг.значения.get("порт"));
