class Чётное {
  static [Symbol.hasInstance](число) {
    return typeof число === "number" && число % 2 === 0;
  }
}

console.log(4 instanceof Чётное);
console.log(7 instanceof Чётное);
