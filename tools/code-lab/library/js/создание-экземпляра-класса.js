class Человек {
  constructor(имя, возраст) {
    this.имя = имя;
    this.возраст = возраст;
  }
}
const className = Человек;
const args = ["Анна", 25];
const человек = new className(...args);
console.log(человек);
