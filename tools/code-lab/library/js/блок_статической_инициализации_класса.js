class Реестр {
  static обработчики = new Map();

  static {
    this.обработчики.set("json", текст => JSON.parse(текст));
    this.обработчики.set("число", текст => Number(текст));
  }
}

console.log(Реестр.обработчики.get("число")("42"));
