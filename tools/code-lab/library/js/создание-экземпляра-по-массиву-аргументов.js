class Человек {
  constructor(имя, возраст) {
    this.имя = имя;
    this.возраст = возраст;
  }
}
const constructor = Человек;
const args = ["Анна", 25];
const человек = Reflect.construct(constructor, args);
console.log(человек instanceof Человек);
console.log(человек);
