class Идентификатор {
  static счётчик = 0;
  static префикс;

  static {
    this.префикс = "ID-";
  }

  static следующий() {
    this.счётчик += 1;
    return this.префикс + this.счётчик;
  }
}

console.log(Идентификатор.следующий());
console.log(Идентификатор.следующий());
