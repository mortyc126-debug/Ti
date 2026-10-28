class Temperature {
  constructor(celsius) {
    this.celsius = celsius;
  }

  static fromFahrenheit(fahrenheit) {
    return new Temperature(((fahrenheit - 32) * 5) / 9);
  }
}

const boiling = Temperature.fromFahrenheit(212);

console.log(boiling.celsius);
console.log(typeof boiling.fromFahrenheit);
