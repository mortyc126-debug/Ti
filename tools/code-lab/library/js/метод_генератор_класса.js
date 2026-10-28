class Счётчик {
  constructor(предел) {
    this.предел = предел;
  }
  *числа() {
    for (let i = 1; i <= this.предел; i++) {
      yield i;
    }
  }
}

console.log([...new Счётчик(3).числа()]);
