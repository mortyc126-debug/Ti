class Temperature {
  #celsius = 0;

  get celsius() {
    return this.#celsius;
  }

  set celsius(degrees) {
    if (typeof degrees !== "number" || Number.isNaN(degrees)) {
      throw new TypeError("Нужно число");
    }
    this.#celsius = degrees;
  }

  get fahrenheit() {
    return (this.#celsius * 9) / 5 + 32;
  }
}

const room = new Temperature();
room.celsius = 25;
console.log(room.celsius, room.fahrenheit);

try {
  room.celsius = "тепло";
} catch (error) {
  console.log(error.message);
}
